import { Hono } from 'hono';
import { ControllerKvStore } from '../src/utils/controller-storage.ts';
import { ControllerMemoryStore } from '../src/utils/controller-memory-store.ts';
import {
  controllerHash,
  extractReadJson,
  readControllerText,
  saveControllerText,
  strictControllerCalls,
} from '../src/utils/sider-controller.ts';
import { fetchSiderResponse } from '../src/utils/sider-transport.ts';
import { validDeclaredToolInput } from '../src/utils/tool-input-validation.ts';
import type { AnthropicRequest } from '../src/types/anthropic.ts';

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`期望${JSON.stringify(expected)}，实际${JSON.stringify(actual)}`);
  }
}
async function rejects(fn: () => Promise<unknown>, text: string) {
  let message = '';
  try {
    await fn();
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  if (!message.includes(text)) throw new Error(`没有收到预期拒绝${text}：${message}`);
}
const tools: AnthropicRequest['tools'] = [
  {
    name: 'Read',
    input_schema: {
      type: 'object',
      properties: { file_path: { type: 'string' } },
      required: ['file_path'],
    },
  },
  {
    name: 'Write',
    input_schema: {
      type: 'object',
      properties: { file_path: { type: 'string' }, content: { type: 'string' } },
      required: ['file_path', 'content'],
    },
  },
];
function sse(text: string, cid = 'probe-cid', parent: string = crypto.randomUUID()) {
  return new Response(
    [
      {
        code: 0,
        msg: 'ok',
        data: {
          type: 'message_start',
          model: 'claude-opus-5.5',
          message_start: { cid, user_message_id: 'user-1', assistant_message_id: parent },
        },
      },
      { code: 0, msg: 'ok', data: { type: 'text', model: 'claude-opus-5.5', text } },
    ].map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
async function appWithMock(
  fn: (body: any) => Response | Promise<Response>,
  run: (app: Hono) => Promise<void>,
) {
  const original = globalThis.fetch;
  const vars = {
    AUTH_TOKEN: 'controller-test-token',
    SIDER_AUTH_TOKEN: 'controller-sider-token',
    DEEPSEEK_API_KEY: 'unused-key',
    SIDER_CONTROLLER: 'true',
    SIDER_CONTROLLER_STREAMING: 'true',
    SIDER_CONTROLLER_STORAGE: 'memory',
    SIDER_CONTROLLER_PACE_MS: '0',
  };
  const prev = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    prev.set(key, Deno.env.get(key));
    Deno.env.set(key, value);
  }
  try {
    globalThis.fetch = (async (url, init) => {
      if (!String(url).includes('sider.ai')) throw new Error('主控不应调用GLM或其他上游');
      return await fn(JSON.parse(String(init?.body)));
    }) as typeof fetch;
    const routes = await import(
      `../src/routes/messages-hybrid.ts?controller=${crypto.randomUUID()}`
    );
    const app = new Hono();
    app.route('/v1/messages', routes.hybridMessagesRouter);
    await run(app);
  } finally {
    globalThis.fetch = original;
    for (const [key, value] of prev) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}
const headers = { 'x-api-key': 'controller-test-token', 'content-type': 'application/json' };
function send(app: Hono, request: AnthropicRequest) {
  return app.request('/v1/messages', { method: 'POST', headers, body: JSON.stringify(request) });
}

Deno.test('主控HTTP：无cid工具续轮发送增量并保留错误结果，重试不产生重复工具', async () => {
  let count = 0;
  const request: AnthropicRequest = {
    model: 'claude-opus-5.5',
    tools,
    messages: [{ role: 'user', content: '读取文件-' + crypto.randomUUID() }],
  };
  await appWithMock((body) => {
    count++;
    if (count === 1) {
      return sse(
        '[tool_use:Read] id=call_1 input={"file_path":"config.json"}',
        'controller-loop-cid',
        'parent-1',
      );
    }
    equal(body.cid, 'controller-loop-cid');
    equal(body.parent_message_id, 'parent-1');
    equal(body.multi_content[0].text.includes('is_error=true'), true);
    equal(body.multi_content[0].text.includes('读取失败：8080'), true);
    equal(body.multi_content[0].text.includes('tool_use_id=call_1'), true);
    return sse('读取失败，需要用户提供正确路径。', 'controller-loop-cid', 'parent-2');
  }, async (app) => {
    const first = await (await send(app, request)).json();
    equal(first.stop_reason, 'tool_use');
    const replay = await (await send(app, request)).json();
    equal(replay.content, first.content);
    equal(count, 1);
    const next = {
      ...request,
      messages: [...request.messages, { role: 'assistant' as const, content: first.content }, {
        role: 'user' as const,
        content: [{
          type: 'tool_result' as const,
          tool_use_id: first.content[0].id,
          is_error: true,
          content: '读取失败：8080',
        }],
      }],
    };
    const response = await (await send(app, next)).json();
    equal(response.stop_reason, 'end_turn');
    equal(count, 2);
    const invalid = await send(app, {
      ...next,
      messages: [{
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'foreign-id', content: 'x' }],
      }],
    });
    equal(invalid.status, 409);
  });
});
Deno.test('主控HTTP：StoreContent→本地哈希保存→WriteFromRef展开，长正文逐字保真', async () => {
  const content = JSON.stringify({
    images: Array.from(
      { length: 12 },
      (_, i) => ({
        id: i + 1,
        content: '中文"引号"\\路径\n😀'.repeat(900),
        file_path: `asset${i}.png`,
      }),
    ),
  });
  let count = 0;
  await appWithMock((body) => {
    count++;
    if (count === 1) {
      return sse(
        `[tool_use:StoreContent] id=store_1 input=${JSON.stringify({ content })}`,
        'long-body-cid',
        'long-parent-1',
      );
    }
    equal(body.cid, 'long-body-cid');
    equal(body.parent_message_id, 'long-parent-1');
    const ref = body.multi_content[0].text.match(/sha256:[a-f0-9]{64}/)[0];
    return sse(
      `[tool_use:WriteFromRef] id=write_1 input=${
        JSON.stringify({ file_path: 'C:\\isolated\\manifest.json', content_ref: ref })
      }`,
      'long-body-cid',
      'long-parent-2',
    );
  }, async (app) => {
    const response = await send(app, {
      model: 'claude-opus-5.5',
      tools,
      messages: [{ role: 'user', content: '生成12项manifest-' + crypto.randomUUID() }],
    });
    equal(response.status, 200);
    const result = await response.json();
    equal(count, 2);
    equal(result.content[0].name, 'Write');
    equal(result.content[0].input.content, content);
    equal(result.content[0].input.file_path, 'C:\\isolated\\manifest.json');
  });
});
Deno.test('主控校验：未知工具、错误schema、宽松JSON及多工具都禁止执行', async () => {
  for (
    const text of [
      '[tool_use:Unknown] id=1 input={}',
      '[tool_use:Read] id=1 input={"file_path":123}',
      '[tool_use:Write] id=1 input={"file_path":"C:\\temp","content":"x"}',
      '[tool_use:Read] id=1 input={"file_path":"a"}\n[tool_use:Read] id=2 input={"file_path":"b"}',
    ]
  ) {
    let rejected = false;
    try {
      strictControllerCalls(text, tools!);
    } catch {
      rejected = true;
    }
    equal(rejected, true);
  }
});
Deno.test('主控HTTP：无效意图交回同一Sider纠正，GLM不能接管', async () => {
  let count = 0;
  await appWithMock((body) => {
    count++;
    if (count === 1) {
      return sse('[tool_use:Unknown] id=1 input={}', 'correct-cid', 'correct-parent-1');
    }
    equal(body.cid, 'correct-cid');
    equal(body.multi_content[0].text.includes('校验失败'), true);
    return sse(
      '[tool_use:Read] id=1 input={"file_path":"valid.json"}',
      'correct-cid',
      'correct-parent-2',
    );
  }, async (app) => {
    const result = await (await send(app, {
      model: 'claude-opus-5.5',
      tools,
      messages: [{ role: 'user', content: crypto.randomUUID() }],
    })).json();
    equal(count, 2);
    equal(result.content[0].name, 'Read');
  });
});
Deno.test('主控HTTP：实际短增量不受旧历史体量影响', async () => {
  let count = 0;
  await appWithMock((body) => {
    count++;
    if (count === 1) {
      return sse('[tool_use:Read] id=1 input={"file_path":"a"}', 'size-cid', 'size-parent');
    }
    equal(body.multi_content[0].text.length < 5000, true);
    return sse('已完成', 'size-cid', 'size-parent-2');
  }, async (app) => {
    const initial: AnthropicRequest = {
      model: 'claude-opus-5.5',
      tools,
      messages: [{ role: 'user', content: crypto.randomUUID() }],
    };
    const first = await (await send(app, initial)).json();
    const response = await send(app, {
      ...initial,
      messages: [{ role: 'user', content: '旧历史'.repeat(100000) }, {
        role: 'assistant',
        content: first.content,
      }, {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: first.content[0].id, content: 'ok' }],
      }],
    });
    equal(response.status, 200);
    equal(count, 2);
  });
});
Deno.test('主控HTTP：上游603与1135保留错误分类，不能退回GLM', async () => {
  for (const [code, status] of [[603, 413], [1135, 429]]) {
    await appWithMock(
      () =>
        new Response(JSON.stringify({ code, msg: 'Please try again after 1 minutes.' }), {
          status: 400,
        }),
      async (app) => {
        // 每项不同已登记模型，避免前一个额度检查干扰。
        const response = await send(app, {
          model: code === 603 ? 'claude-sonnet-5.5' : 'claude-sonnet-5',
          tools,
          messages: [{ role: 'user', content: crypto.randomUUID() }],
        });
        equal(response.status, status);
        if (status === 429) {
          equal(response.headers.get('retry-after'), '60');
        }
      },
    );
  }
});
Deno.test('主控HTTP：流式输出真正tool_use和tool_use停止原因，无文本调用泄漏', async () => {
  await appWithMock(
    () => sse('[tool_use:Read] id=1 input={"file_path":"a"}', 'stream-cid'),
    async (app) => {
      const response = await send(app, {
        model: 'claude-opus-5.5',
        tools,
        stream: true,
        messages: [{ role: 'user', content: crypto.randomUUID() }],
      });
      const body = await response.text();
      equal(body.includes('"type":"tool_use"'), true);
      equal(body.includes('"stop_reason":"tool_use"'), true);
      equal(body.includes('[tool_use:Read]'), false);
    },
  );
});
Deno.test('KV跨实例：检查点和长正文可恢复，损坏与过期引用拒绝', async () => {
  const kv = await Deno.openKv(':memory:');
  try {
    const a = new ControllerKvStore(kv), b = new ControllerKvStore(kv);
    const content = '中文😀'.repeat(25000);
    await a.write('task', { cid: 'real-cid', parent: 'parent' }, 10000);
    equal(await b.read('task'), { cid: 'real-cid', parent: 'parent' });
    await saveControllerText(a, 'asset', content);
    equal(await readControllerText(b, 'asset'), content);
    await b.write('asset:0', 'corrupted', 10000);
    await rejects(() => readControllerText(a, 'asset'), '哈希');
    await a.write('expired', 'body', -1);
    equal(await b.read('expired'), null);
  } finally {
    kv.close();
  }
});
Deno.test('KV账号租约：跨实例互斥、持有到结束、旧holder不能释放新租约', async () => {
  const kv = await Deno.openKv(':memory:');
  try {
    const a = new ControllerKvStore(kv), b = new ControllerKvStore(kv);
    const claims = await Promise.all([
      a.claim('account', 'a', 1000),
      b.claim('account', 'b', 1000),
    ]);
    equal(claims.filter(Boolean).length, 1);
    const winner = claims[0] ? 'a' : 'b';
    await a.release('account', 'wrong');
    equal(await b.claim('account', 'c', 1000), false);
    await b.release('account', winner);
    equal(await a.claim('account', 'new', 1000), true);
    await a.release('account', winner);
    equal(await b.claim('account', 'old', 1000), false);
  } finally {
    kv.close();
  }
});
Deno.test('内容库隔离：不同任务与调用者无法读取另一个正文引用', async () => {
  const store = new ControllerMemoryStore();
  await saveControllerText(store, 'owner-a:task-a:asset', '正文');
  await rejects(() => readControllerText(store, 'owner-b:task-a:asset'), '不属于');
  await rejects(() => readControllerText(store, 'owner-a:task-b:asset'), '不属于');
  equal((await controllerHash('正文')).length, 64);
});
Deno.test('Sider空闲超时：持续上游字节可超过空闲窗口，静默卡住会取消reader', async () => {
  const original = globalThis.fetch;
  let timer: ReturnType<typeof setInterval> | undefined;
  let cancelled = false;
  try {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(c) {
              let count = 0;
              timer = setInterval(() => {
                c.enqueue(new TextEncoder().encode('x'));
                if (++count === 6) {
                  clearInterval(timer);
                  c.close();
                }
              }, 10);
            },
          }),
        ),
      )) as typeof fetch;
    equal((await (await fetchSiderResponse('https://sider.ai/x', {}, 30, 200)).text()).length, 6);
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
        ),
      )) as typeof fetch;
    await rejects(
      async () => await (await fetchSiderResponse('https://sider.ai/x', {}, 20, 200)).text(),
      'idle timeout',
    );
    equal(cancelled, true);
  } finally {
    clearInterval(timer);
    globalThis.fetch = original;
  }
});
Deno.test('Sider总期限：持续心跳仍不能无限占用账号', async () => {
  const original = globalThis.fetch;
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(c) {
              timer = setInterval(() => c.enqueue(new Uint8Array([120])), 5);
            },
            cancel() {
              clearInterval(timer);
            },
          }),
        ),
      )) as typeof fetch;
    await rejects(
      async () => await (await fetchSiderResponse('https://sider.ai/x', {}, 30, 50)).text(),
      'total timeout',
    );
  } finally {
    clearInterval(timer);
    globalThis.fetch = original;
  }
});

Deno.test('主控大上下文：安全分块登记后重申最新请求并直接执行，不能再次只确认已记住', async () => {
  let uploads = 0;
  const latestRequest = '必须使用Read读取a-' + crypto.randomUUID();
  await appWithMock((body) => {
    const text = body.multi_content[0].text;
    if (text.includes('上下文片段')) {
      uploads++;
      equal(text.length <= 6000, true);
      return sse(
        uploads === 1 ? '[tool_use:Read] id=early input={"file_path":"不能提前执行"}' : '已记住',
        'bootstrap-cid',
        `parent-${uploads}`,
      );
    }
    if (!text.includes('上下文登记阶段已经结束') || !text.includes(latestRequest)) {
      return sse('已记住任务上下文，请提供具体指令。', 'bootstrap-cid', 'still-bootstrapping');
    }
    equal(text.includes('"name":"Read"'), true);
    equal(text.includes('"file_path":{"type":"string"}'), true);
    return sse('[tool_use:Read] id=1 input={"file_path":"a"}', 'bootstrap-cid', 'done');
  }, async (app) => {
    const response = await send(app, {
      model: 'claude-opus-5.5',
      tools,
      system: '独立完整规范'.repeat(5000),
      messages: [{ role: 'user', content: latestRequest }],
    });
    equal(response.status, 200);
    equal(uploads >= 2, true);
    const result = await response.json();
    equal(result.stop_reason, 'tool_use');
    equal(result.content[0].name, 'Read');
  });
});

Deno.test('主控纠错：完整工具schema超出单轮上限时再次分段，不能返回413', async () => {
  const largeTools: AnthropicRequest['tools'] = [{
    name: 'Read',
    description: '完整工具说明'.repeat(1800),
    input_schema: {
      type: 'object',
      properties: { file_path: { type: 'string' } },
      required: ['file_path'],
    },
  }];
  let businessCalls = 0;
  let uploads = 0;
  await appWithMock((body) => {
    const text = body.multi_content[0].text;
    if (text.includes('上下文片段')) {
      uploads++;
      equal(text.length <= 6000, true);
      return sse('已记住', 'large-correction-cid', crypto.randomUUID());
    }
    businessCalls++;
    if (businessCalls === 1) {
      return sse(
        '[tool_use:Read] id=bad input={"file_path":123}',
        'large-correction-cid',
        'large-correction-parent-1',
      );
    }
    return sse(
      '[tool_use:Read] id=good input={"file_path":"valid.txt"}',
      'large-correction-cid',
      'large-correction-parent-2',
    );
  }, async (app) => {
    const response = await send(app, {
      model: 'claude-opus-5.5',
      tools: largeTools,
      messages: [{ role: 'user', content: '读取valid.txt' }],
    });
    equal(response.status, 200);
    const result = await response.json();
    equal(uploads >= 2, true);
    equal(result.stop_reason, 'tool_use');
    equal(result.content[0].input.file_path, 'valid.txt');
  });
});

Deno.test('主控工具续轮：大型Read结果不是新需求，必须继续原始任务而非等待指令', async () => {
  const goal = '先读取技能规范，然后生成C:/isolated/result.txt并写入完成。' +
    '必须保持原始任务约束。'.repeat(80);
  let businessCalls = 0;
  let sawContinuationAnchor = false;
  let sawCompleteGoal = false;
  await appWithMock((body) => {
    const text = body.multi_content[0].text;
    if (text.includes('上下文片段')) {
      return sse('已记住', 'goal-anchor-cid', crypto.randomUUID());
    }
    businessCalls++;
    if (businessCalls === 1) {
      return sse(
        '[tool_use:Read] id=read_skill input={"file_path":"C:/skills/SKILL.md"}',
        'goal-anchor-cid',
        'goal-parent-1',
      );
    }
    sawContinuationAnchor = text.includes('工具结果不是新的用户任务');
    sawCompleteGoal = text.includes(goal);
    if (!sawContinuationAnchor || !sawCompleteGoal) {
      return sse('规范已加载，请提供初始任务。', 'goal-anchor-cid', 'goal-parent-wait');
    }
    return sse(
      '[tool_use:Write] id=write_result input={"file_path":"C:/isolated/result.txt","content":"完成"}',
      'goal-anchor-cid',
      'goal-parent-2',
    );
  }, async (app) => {
    const initial: AnthropicRequest = {
      model: 'claude-opus-5.5',
      tools,
      messages: [{ role: 'user', content: goal }, {
        role: 'assistant',
        content: [{ type: 'text', text: '准备按任务读取技能。' }],
      }, {
        role: 'user',
        content: [{
          type: 'text',
          text: '<system-reminder>内部动态上下文，不是用户任务，且可能在传输中被截断',
        }],
      }],
    };
    const first = await (await send(app, initial)).json();
    equal(first.stop_reason, 'tool_use');

    const second = await (await send(app, {
      ...initial,
      messages: [...initial.messages, { role: 'assistant', content: first.content }, {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: first.content[0].id,
          content: '技能规范正文\n'.repeat(3000),
        }, {
          type: 'text',
          text: '最新用户请求原文：',
        }],
      }],
    })).json();

    equal(sawContinuationAnchor, true);
    equal(sawCompleteGoal, true);
    equal(second.stop_reason, 'tool_use');
    equal(second.content[0].name, 'Write');
  });
});
Deno.test('主控建立连接失败仅重试一次，已读取的业务错误不重试', async () => {
  let attempts = 0;
  await appWithMock(() => {
    if (++attempts === 1) throw new Error('client error (Connect): tcp connect error');
    return sse('[tool_use:Read] id=1 input={"file_path":"a"}', 'retry-connect-cid');
  }, async (app) => {
    const response = await send(app, {
      model: 'claude-opus-5.5',
      tools,
      messages: [{ role: 'user', content: crypto.randomUUID() }],
    });
    equal(response.status, 200);
    equal(attempts, 2);
  });
});

Deno.test('真实Claude Code2020-12 schema：Write引用展开符合方言且不能改写参数', () => {
  const tool: any = {
    name: 'Write',
    input_schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { file_path: { type: 'string' }, content: { type: 'string' } },
      required: ['file_path', 'content'],
      additionalProperties: false,
    },
  };
  equal(
    validDeclaredToolInput([tool], 'Write', {
      file_path: 'C:/isolated/output.json',
      content: '中文\\"\n',
    }),
    true,
  );
  equal(
    validDeclaredToolInput([tool], 'Write', { file_path: 'C:/isolated/output.json', content: 123 }),
    false,
  );
});
Deno.test('主控StoreContent成功但未提交Write：不能把提前完成自述发给客户端', async () => {
  let count = 0;
  await appWithMock(() => {
    count++;
    if (count === 1) {
      return sse('[tool_use:StoreContent] id=1 input={"content":"正文"}', 'must-write-cid');
    }
    if (count === 2) return sse('文件已写入，任务已完成。', 'must-write-cid');
    return sse(
      '[tool_use:Write] id=3 input={"file_path":"C:/isolated/output.json","content":"正文"}',
      'must-write-cid',
    );
  }, async (app) => {
    const result = await (await send(app, {
      model: 'claude-opus-5.5',
      tools,
      messages: [{ role: 'user', content: crypto.randomUUID() }],
    })).json();
    equal(count, 3);
    equal(result.content[0].type, 'tool_use');
    equal(result.content[0].name, 'Write');
  });
});
Deno.test('真实Read JSON展示：只剥离连续行号，不猜测截断、换行及坏JSON', () => {
  const content = '{\n  "text":"中文\\n\\\\路径"\n}';
  equal(
    extractReadJson(content.split('\n').map((line, i) => `${i + 1}\t${line}`).join('\n')),
    content,
  );
  equal(extractReadJson('1\t{\n3\t}'), null);
  equal(extractReadJson('1\t{\\n}'), null);
  equal(extractReadJson('正文无行号'), null);
});
Deno.test('逐字复制：Read原文由本地保存引用，禁止模型重写或重复转义', async () => {
  const content = '{\n  "text":"中文\\n\\\\路径"\n}';
  let calls = 0;
  let ref = '';
  await appWithMock((body) => {
    calls++;
    if (calls === 1) {
      return sse(
        '[tool_use:Read] id=read input={"file_path":"C:/isolated/source.json"}',
        'copy-cid',
      );
    }
    ref = body.multi_content[0].text.match(/sha256:[a-f0-9]{64}/)?.[0] ?? '';
    equal(!!ref, true);
    return sse(
      `[tool_use:WriteFromRef] id=write input=${
        JSON.stringify({ file_path: 'C:/isolated/output.json', content_ref: ref })
      }`,
      'copy-cid',
    );
  }, async (app) => {
    const messages: any[] = [{
      role: 'user',
      content: '将C:/isolated/source.json正文逐字复制到C:/isolated/output.json-' +
        crypto.randomUUID(),
    }];
    const first = await (await send(app, { model: 'claude-opus-5.5', tools, messages })).json();
    messages.push({ role: 'assistant', content: first.content }, {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: first.content[0].id,
        content: content.split('\n').map((line, i) => `${i + 1}\t${line}`).join('\n'),
      }],
    });
    const next = await (await send(app, { model: 'claude-opus-5.5', tools, messages })).json();
    equal(next.content[0].name, 'Write');
    equal(next.content[0].input.content, content);
    equal(calls, 2);
  });
});
Deno.test('主控明确拒绝工具结果中的嵌套图片，不静默丢弃', async () => {
  let calls = 0;
  await appWithMock(() => {
    calls++;
    return sse('不应调用');
  }, async (app) => {
    const response = await send(app, {
      model: 'claude-opus-5.5',
      tools,
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'image-test',
          content: [{
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'test' },
          }],
        }],
      }],
    });
    equal(response.status, 400);
    equal(calls, 0);
  });
});
Deno.test('主控兼容原会话query cid：单消息续轮恢复真实父消息', async () => {
  let calls = 0;
  await appWithMock((body) => {
    calls++;
    if (calls === 1) return sse('记住42', 'query-real-cid', 'query-parent-1');
    equal(body.cid, 'query-real-cid');
    equal(body.parent_message_id, 'query-parent-1');
    return sse('42', 'query-real-cid', 'query-parent-2');
  }, async (app) => {
    const first = await send(app, {
      model: 'claude-opus-5.5',
      messages: [{ role: 'user', content: '记住42-' + crypto.randomUUID() }],
    });
    const body = await first.json();
    const next = await app.request('/v1/messages?cid=' + body.sider_session.conversation_id, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'claude-opus-5.5',
        messages: [{ role: 'user', content: '数字是多少？' }],
      }),
    });
    equal(next.status, 200);
    equal((await next.json()).content[0].text, '42');
    equal(calls, 2);
  });
});

Deno.test('主控响应缓存：相同续轮正文按query cid隔离', async () => {
  let calls = 0;
  await appWithMock((body) => {
    calls++;
    if (calls === 1) return sse('已记住A', 'real-cid-a', 'parent-a-1');
    if (calls === 2) {
      equal(body.cid, 'real-cid-a');
      return sse('MARKER_A', 'real-cid-a', 'parent-a-2');
    }
    if (calls === 3) return sse('已记住B', 'real-cid-b', 'parent-b-1');
    equal(body.cid, 'real-cid-b');
    return sse('MARKER_B', 'real-cid-b', 'parent-b-2');
  }, async (app) => {
    const create = async (marker: string) => {
      const response = await send(app, {
        model: 'claude-opus-5.5',
        messages: [{ role: 'user', content: `记住${marker}-${crypto.randomUUID()}` }],
      });
      return await response.json();
    };
    const resume = async (cid: string) => {
      const response = await app.request(`/v1/messages?cid=${cid}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: 'claude-opus-5.5',
          messages: [{ role: 'user', content: '标记是什么？' }],
        }),
      });
      equal(response.status, 200);
      return await response.json();
    };

    const first = await create('MARKER_A');
    const firstReply = await resume(first.sider_session.conversation_id);
    equal(firstReply.content[0].text, 'MARKER_A');
    equal(firstReply.sider_session.conversation_id, first.sider_session.conversation_id);

    const second = await create('MARKER_B');
    const secondReply = await resume(second.sider_session.conversation_id);
    equal(secondReply.content[0].text, 'MARKER_B');
    equal(secondReply.sider_session.conversation_id, second.sider_session.conversation_id);
    equal(calls, 4);
  });
});
