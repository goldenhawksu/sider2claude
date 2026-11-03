import * as controller from '../src/utils/sider-controller.ts';
import { controllerResponse } from '../src/utils/controller-http.ts';
import { ControllerKvStore, getControllerStore } from '../src/utils/controller-storage.ts';
import { createRequestLogContext } from '../src/utils/request-observability.ts';
import type { AnthropicRequest } from '../src/types/anthropic.ts';
import type { SiderRequest } from '../src/types/index.ts';

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`期望${JSON.stringify(expected)}，实际${JSON.stringify(actual)}`);
  }
}
type Checkpoint = {
  id: string;
  cid: string;
  parent: string;
  uploads?: Record<string, number>;
  pendingUpload?: string;
};
function sse(body: SiderRequest, text: string, parent: string) {
  return new Response(
    [
      {
        code: 0,
        data: {
          type: 'message_start',
          model: body.model,
          message_start: {
            cid: body.cid || 'fixture-cid',
            user_message_id: 'u',
            assistant_message_id: parent,
          },
        },
      },
      { code: 0, data: { type: 'text', model: body.model, text } },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
function request(): AnthropicRequest {
  return {
    model: 'deepseek-v4-flash',
    stream: true,
    system: '合成测试规范。'.repeat(600),
    messages: [{ role: 'user', content: crypto.randomUUID() }],
  };
}
function part(body: SiderRequest): number | undefined {
  const match = body.multi_content[0]!.text.match(/^以下是当前任务上下文片段(\d+)\/(\d+)/);
  if (match) equal(Number(match[2]), 2);
  return match ? Number(match[1]) : undefined;
}

async function fixture(
  run: (f: {
    store: Awaited<ReturnType<typeof getControllerStore>>;
    snapshots: Checkpoint[];
    logs: unknown[][];
    restart: () => Promise<typeof controller>;
    checkpoint: () => Promise<Checkpoint>;
    mock: (fn: (body: SiderRequest) => Response | Promise<Response>) => void;
  }) => Promise<void>,
) {
  const env = {
    SIDER_AUTH_TOKEN: 'fixture-account',
    SIDER_CONTROLLER_STORAGE: 'memory',
    SIDER_CONTROLLER: 'true',
    SIDER_CONTROLLER_STREAMING: 'true',
    SIDER_CONTROLLER_PACE_MS: '0',
    SIDER_CONTROLLER_PACE_MIN_MS: '0',
    SIDER_CONTROLLER_MAX_INPUT_CHARS: '3000',
    SIDER_CONTROLLER_STREAM_COMMIT_MS: '20000',
    DENO_DEPLOYMENT_ID: '',
    SIDER_TOTAL_TIMEOUT_MS: '5000',
    AUTH_TOKEN: 'fixture-client',
  };
  for (let i = 1; i <= 8; i++) Object.assign(env, { [`SIDER_AUTH_TOKEN_${i}`]: '' });
  const previous = new Map(Object.keys(env).map((key) => [key, Deno.env.get(key)]));
  for (const [key, value] of Object.entries(env)) Deno.env.set(key, value);
  const kv = await Deno.openKv(':memory:');
  let storage = new ControllerKvStore(kv);
  const store = await getControllerStore();
  const original = {
    read: store.read,
    write: store.write,
    claim: store.claim,
    release: store.release,
    fetch: globalThis.fetch,
    info: console.info,
    warn: console.warn,
    log: console.log,
    error: console.error,
  };
  const snapshots: Checkpoint[] = [], logs: unknown[][] = [];
  let taskKey = '';
  store.read = (key) => storage.read(key);
  store.write = async (key, value, ttl) => {
    await storage.write(key, value, ttl);
    if (/^[a-f0-9]+:task:/.test(key)) {
      taskKey = key;
      snapshots.push(structuredClone(value) as Checkpoint);
    }
  };
  store.claim = (key, holder, ttl) => storage.claim(key, holder, ttl);
  store.release = (key, holder) => storage.release(key, holder);
  console.info =
    console.warn =
    console.log =
    console.error =
      (...args) => {
        logs.push(args);
      };
  try {
    await run({
      store,
      snapshots,
      logs,
      restart: async () => {
        // 重建控制器模块和存储适配器，只保留共享 KV；读取获得新对象。
        storage = new ControllerKvStore(kv);
        return await import(`../src/utils/sider-controller.ts?cold=${crypto.randomUUID()}`);
      },
      checkpoint: async () => (await storage.read<Checkpoint>(taskKey))!,
      mock: (fn) => {
        globalThis.fetch = ((url, init) => {
          if (!String(url).includes('sider.ai')) throw new Error('禁止调用非 mock 上游');
          return Promise.resolve(fn(JSON.parse(String(init?.body))));
        }) as typeof fetch;
      },
    });
  } finally {
    Object.assign(store, {
      read: original.read,
      write: original.write,
      claim: original.claim,
      release: original.release,
    });
    globalThis.fetch = original.fetch;
    Object.assign(console, {
      info: original.info,
      warn: original.warn,
      log: original.log,
      error: original.error,
    });
    kv.close();
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

Deno.test('上传诊断：明确 ACK 的会话父节点与分片检查点一次提交', async () => {
  await fixture(async (f) => {
    const calls: (number | string)[] = [];
    f.mock((body) => {
      const index = part(body);
      calls.push(index ?? 'answer');
      if (index === 2) equal(body.parent_message_id, 'p1');
      return sse(body, index ? `已记住${index}/2` : '真实合成回答', index ? `p${index}` : 'answer');
    });
    const result = await controller.runSiderController(request(), 'ack-owner');
    equal(calls, [1, 2, 'answer']);
    equal(result.content.find((block) => block.type === 'text')?.text, '真实合成回答');
    for (const index of [1, 2]) {
      equal(
        f.snapshots.some((s) =>
          s.parent === `p${index}` &&
          !Object.values(s.uploads ?? {}).includes(index)
        ),
        false,
      );
    }
    equal((await f.checkpoint()).pendingUpload, undefined);
  });
});

for (
  const [failedPart, reply, category] of [
    [1, '这是一段合成的普通分析答案。'.repeat(100), 'missing_ack'],
    [2, '这是一段合成的普通分析答案。'.repeat(100), 'missing_ack'],
    [2, '已收到，但我不能接受或记住这些片段。', 'explicit_rejection'],
  ] as const
) {
  Deno.test(`上传诊断：第${failedPart}片 ${category} 后跨实例从已确认父节点重试`, async () => {
    await fixture(async (f) => {
      const calls: (number | string)[] = [];
      let failed = false;
      f.mock((body) => {
        const index = part(body);
        calls.push(index ?? 'answer');
        equal(body.cid, index === 1 ? '' : 'fixture-cid');
        equal(body.parent_message_id, index === 1 ? undefined : index === 2 ? 'p1' : 'p2');
        if (index === failedPart && !failed) {
          failed = true;
          return sse(body, reply, 'unconfirmed-parent');
        }
        return sse(
          body,
          index ? `已记住${index}/2` : '真实合成回答',
          index ? `p${index}` : 'answer',
        );
      });
      const req = request(), owner = crypto.randomUUID();
      let caught: unknown;
      try {
        await controller.runSiderController(req, owner);
      } catch (error) {
        caught = error;
      }
      equal(caught instanceof controller.ControllerError, true);
      equal(calls, failedPart === 1 ? [1] : [1, 2]);
      const before = await f.checkpoint();
      equal([before.cid, before.parent], failedPart === 1 ? ['', ''] : ['fixture-cid', 'p1']);
      equal(Object.values(before.uploads ?? {}), failedPart === 1 ? [] : [1]);
      equal(typeof before.pendingUpload, 'string');
      equal((caught as { code?: string }).code, 'context_unconfirmed');
      const resumed = await f.restart();
      const result = await resumed.runSiderController(req, owner);
      equal(calls, failedPart === 1 ? [1, 1, 2, 'answer'] : [1, 2, 2, 'answer']);
      equal(result.content.find((block) => block.type === 'text')?.text, '真实合成回答');
      equal((await f.checkpoint()).pendingUpload, undefined);
      const diagnostics = f.logs.map((args) => args[1] as Record<string, unknown>)
        .filter((entry) => entry?.event === 'controller_context_upload');
      equal(diagnostics.some((entry) => entry.ack === category), true);
      equal(diagnostics.some((entry) => entry.resumed === true), true);
      equal(JSON.stringify(f.logs).includes(reply), false);
    });
  });
}

Deno.test('上传诊断：多账号同时首次处理同一请求不能双重发送', async () => {
  await fixture(async (f) => {
    Deno.env.set('SIDER_AUTH_TOKEN_1', 'fixture-account-2');
    const fresh = await f.restart();
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const duplicate = Promise.withResolvers<void>();
    const write = f.store.write;
    let taskWrites = 0, calls = 0;
    f.store.write = async (key, value, ttl) => {
      if (/^[a-f0-9]+:task:/.test(key)) {
        taskWrites++;
        if (taskWrites === 1) entered.resolve();
        else duplicate.resolve();
        await gate.promise;
      }
      await write(key, value, ttl);
    };
    f.mock((body) => {
      calls++;
      return sse(body, '真实回答', 'answer');
    });
    const req: AnthropicRequest = {
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: crypto.randomUUID() }],
    };
    const first = controller.runSiderController(req, 'concurrent-owner');
    await entered.promise;
    const second = fresh.runSiderController(req, 'concurrent-owner').catch((error) => error);
    await Promise.race([duplicate.promise, second]);
    gate.resolve();
    const [a, b] = await Promise.all([first, second]);
    equal(calls, 1);
    if (b instanceof Error) equal((b as { statusCode?: number }).statusCode, 429);
    else equal(a.id, b.id);
  });
});

Deno.test('上传诊断：ACK 检查点写入失败后重建实例不会跳片', async () => {
  await fixture(async (f) => {
    const write = f.store.write;
    let failWrite = true;
    f.store.write = async (key, value, ttl) => {
      const task = value as Checkpoint;
      if (/:task:/.test(key) && task.parent === 'p2' && failWrite) {
        failWrite = false;
        throw new Error('合成存储中断');
      }
      await write(key, value, ttl);
    };
    const calls: (number | string)[] = [];
    f.mock((body) => {
      const index = part(body);
      calls.push(index ?? 'answer');
      return sse(body, index ? `已记住${index}/2` : '真实回答', index ? `p${index}` : 'answer');
    });
    const req = request(), owner = crypto.randomUUID();
    let error: unknown;
    try {
      await controller.runSiderController(req, owner);
    } catch (caught) {
      error = caught;
    }
    equal((error as Error).message, '合成存储中断');
    equal((await f.checkpoint()).parent, 'p1');
    equal(Object.values((await f.checkpoint()).uploads ?? {}), [1]);
    const fresh = await f.restart();
    await fresh.runSiderController(req, owner);
    equal(calls, [1, 2, 2, 'answer']);
  });
});

Deno.test('上传诊断：不同任务可并发且续轮保持各自会话', async () => {
  await fixture(async (f) => {
    Deno.env.set('SIDER_AUTH_TOKEN_1', 'fixture-account-2');
    const fresh = await f.restart();
    const both = Promise.withResolvers<void>();
    const calls: string[] = [];
    f.mock(async (body) => {
      calls.push(body.cid);
      if (calls.length === 2) both.resolve();
      if (calls.length <= 2) await both.promise;
      const cid = body.cid || (body.multi_content[0]!.text.includes('任务甲') ? 'cid-a' : 'cid-b');
      return sse({ ...body, cid }, '真实回答', `${cid}-parent`);
    });
    const owner = crypto.randomUUID();
    const req = (text: string): AnthropicRequest => ({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: text }],
    });
    const [a, b] = await Promise.all([
      controller.runSiderController(req('任务甲'), owner),
      fresh.runSiderController(req('任务乙'), owner),
    ]);
    equal(calls, ['', '']);
    equal(a.sider_session!.conversation_id === b.sider_session!.conversation_id, false);
    await controller.runSiderController(
      req('甲继续'),
      owner,
      undefined,
      a.sider_session!.conversation_id,
    );
    await fresh.runSiderController(
      req('乙继续'),
      owner,
      undefined,
      b.sider_session!.conversation_id,
    );
    equal(calls.slice(2), ['cid-a', 'cid-b']);
  });
});

async function sendProtocol(req: AnthropicRequest, protocol: 'anthropic' | 'openai') {
  if (protocol === 'anthropic') {
    return await controllerResponse(
      req,
      'fixture-client',
      createRequestLogContext(req, 'req-fixture'),
    );
  }
  const { default: router } = await import('../src/routes/protocols.ts');
  return await router.request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'fixture-client' },
    body: JSON.stringify({
      model: req.model,
      stream: req.stream,
      messages: [...(req.system ? [{ role: 'system', content: req.system }] : []), ...req.messages],
    }),
  });
}

for (const protocol of ['anthropic', 'openai'] as const) {
  Deno.test(`上传诊断 HTTP：${protocol} 开流前非 ACK 保留 502 原因和机器码，不附带限流头`, async () => {
    await fixture(async (f) => {
      const secret = 'fixture-private-response-Authorization-Bearer-token';
      let calls = 0;
      f.mock((body) => {
        calls++;
        return sse(body, secret.repeat(30), 'rejected');
      });
      const req = request();
      const response = await sendProtocol(req, protocol);
      equal(response.status, 502);
      equal(response.headers.get('retry-after'), null);
      const json = await response.json();
      equal(
        protocol === 'openai' ? json.error.details?.code : json.error.code,
        'context_unconfirmed',
      );
      equal(json.error.message.includes('未确认上下文分片1/2'), true);
      equal(calls, 1);
      equal(JSON.stringify(json).includes(secret), false);
      const logs = JSON.stringify(f.logs);
      for (const privateText of [secret, req.system, req.messages[0]!.content, 'fixture-account']) {
        equal(logs.includes(String(privateText)), false);
      }
      const diagnostic = f.logs.map((args) => args[1] as Record<string, unknown>)
        .find((entry) => entry?.event === 'controller_context_upload')!;
      equal(diagnostic.ack, 'missing_ack');
      equal(diagnostic.responseChars, secret.length * 30);
      equal([diagnostic.chunkIndex, diagnostic.chunkCount], [1, 2]);
      equal(String(diagnostic.contextHash).length, 16);
      equal(typeof diagnostic.requestId, 'string');
      equal(diagnostic.model, req.model);
      if (protocol === 'anthropic') equal(diagnostic.requestId, 'req-fixture');
    });
  });

  Deno.test(`上传诊断 HTTP：${protocol} 供应商1135保留429及60秒退避`, async () => {
    await fixture(async (f) => {
      f.mock(() =>
        new Response(
          'data: ' + JSON.stringify({ code: 1135, msg: 'Please try again after 1 minutes.' }) +
            '\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        )
      );
      const response = await sendProtocol({
        model: 'deepseek-v4-flash',
        stream: true,
        messages: [{ role: 'user', content: crypto.randomUUID() }],
      }, protocol);
      equal(response.status, 429);
      equal(response.headers.get('retry-after'), '60');
      const json = await response.json();
      equal(protocol === 'openai' ? json.error.details?.code : json.error.code, 'sider_1135');
    });
  });

  Deno.test(`上传诊断 HTTP：${protocol} 登记检查点429保持原续传语义并可辨识`, async () => {
    await fixture(async (f) => {
      Deno.env.set('DENO_DEPLOYMENT_ID', 'fixture-deployment');
      f.mock((body) => sse(body, `已记住${part(body)}/2`, `p${part(body)}`));
      const response = await sendProtocol({ ...request(), stream: false }, protocol);
      equal(response.status, 429);
      equal(response.headers.get('retry-after'), '1');
      const json = await response.json();
      equal(
        protocol === 'openai' ? json.error.details?.code : json.error.code,
        'context_checkpoint',
      );
      equal(json.error.message.includes('上下文登记进度2/2'), true);
      equal(Object.values((await f.checkpoint()).uploads ?? {}), [2]);
    });
  });

  Deno.test(`上传诊断 HTTP：${protocol} 正文已流出后失败必须有错误事件`, async () => {
    await fixture(async (f) => {
      f.mock((body) => {
        const bytes = new TextEncoder();
        let sent = false;
        return new Response(
          new ReadableStream({
            pull(stream) {
              if (sent) {
                stream.error(new Error('合成上游流中断'));
                return;
              }
              sent = true;
              stream.enqueue(bytes.encode(
                [
                  {
                    code: 0,
                    data: {
                      type: 'message_start',
                      model: body.model,
                      message_start: {
                        cid: 'stream-cid',
                        user_message_id: 'u',
                        assistant_message_id: 'p',
                      },
                    },
                  },
                  { code: 0, data: { type: 'text', model: body.model, text: '合成正文开头' } },
                ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
              ));
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      });
      const response = await sendProtocol({
        model: 'deepseek-v4-flash',
        stream: true,
        messages: [{ role: 'user', content: crypto.randomUUID() }],
      }, protocol);
      equal(response.status, 200);
      const text = await response.text();
      equal(text.includes('合成正文开头'), true);
      equal(text.includes('"error"'), true);
      equal(text.includes('"finish_reason":"stop"'), false);
      equal(text.includes('event: message_stop'), false);
      if (protocol === 'anthropic') {
        equal(text.indexOf('event: content_block_stop') < text.indexOf('event: error'), true);
      }
    });
  });
}

Deno.test('上传诊断：默认日志不包含凭证、用户正文或历史工具参数', async () => {
  await fixture(async (f) => {
    const id = crypto.randomUUID();
    const req: AnthropicRequest = {
      ...request(),
      tools: [{
        name: 'Bash',
        input_schema: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
      }],
      messages: [
        { role: 'user', content: 'private_user_body Authorization: Bearer private_client_token' },
        {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id,
            name: 'Bash',
            input: { command: 'private_tool_parameter' },
          }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: id, content: 'private_tool_result' }],
        },
      ],
    };
    f.mock((body) => sse(body, 'private_model_echo'.repeat(100), 'unconfirmed'));
    const response = await controllerResponse(
      req,
      'private_client_token',
      createRequestLogContext(req),
    );
    equal(response.status, 502);
    const logs = JSON.stringify(f.logs);
    for (
      const secret of [
        'private_user_body',
        'Authorization:',
        'private_client_token',
        'private_tool_parameter',
        'private_tool_result',
        'private_model_echo',
        'fixture-account',
        String(req.system),
      ]
    ) equal(logs.includes(secret), false);
  });
});

for (const protocol of ['anthropic', 'openai'] as const) {
  Deno.test(`上传诊断 HTTP：${protocol} 已提交 SSE 的非 ACK 保留机器原因且无成功结束`, async () => {
    await fixture(async (f) => {
      Deno.env.set('SIDER_CONTROLLER_STREAM_COMMIT_MS', '0');
      f.mock((body) => sse(body, '合成普通答案。'.repeat(150), 'unconfirmed'));
      const response = await sendProtocol(request(), protocol);
      equal(response.status, 200);
      const text = await response.text();
      const events = text.split('\n').filter((line) => line.startsWith('data: {'))
        .map((line) => JSON.parse(line.slice(6)));
      const error = events.find((event) => event.error)?.error;
      equal(protocol === 'openai' ? error?.details?.code : error?.code, 'context_unconfirmed');
      equal(text.includes('合成普通答案'), false);
      equal(text.includes('event: message_stop'), false);
      equal(text.includes('"finish_reason":"stop"'), false);
    });
  });
}

for (
  const [deployed, stream, configured, effective] of [
    [true, false, undefined, 70_000],
    [true, false, '20000', 20_000],
    [true, false, '120000', 70_000],
    [true, true, undefined, 600_000],
    [true, true, '120000', 120_000],
    [false, false, undefined, 600_000],
  ] as const
) {
  Deno.test(`请求锁期限：deployed=${deployed} stream=${stream} timeout=${configured ?? 'default'}`, async () => {
    await fixture(async (f) => {
      Deno.env.set('DENO_DEPLOYMENT_ID', deployed ? 'fixture-deployment' : '');
      if (configured) Deno.env.set('SIDER_TOTAL_TIMEOUT_MS', configured);
      else Deno.env.delete('SIDER_TOTAL_TIMEOUT_MS');
      const claims: { key: string; ttl: number }[] = [];
      const claim = f.store.claim;
      f.store.claim = (key, holder, ttl) => {
        claims.push({ key, ttl });
        return claim(key, holder, ttl);
      };
      f.mock((body) => sse(body, '合成回答', 'p'));
      await controller.runSiderController({
        model: 'deepseek-v4-flash',
        stream,
        messages: [{ role: 'user', content: crypto.randomUUID() }],
      }, crypto.randomUUID());
      equal(claims.find((entry) => entry.key.startsWith('request:'))?.ttl, effective + 35_000);
      equal(claims.find((entry) => entry.key.startsWith('account:'))?.ttl, effective + 5_000);
    });
  });
}

Deno.test('请求锁期限：模拟进程未释放锁，在有效期限和余量结束后恢复', async () => {
  await fixture(async (f) => {
    Deno.env.set('DENO_DEPLOYMENT_ID', 'fixture-deployment');
    Deno.env.delete('SIDER_TOTAL_TIMEOUT_MS');
    const originalNow = Date.now;
    let now = originalNow(), interrupted = true, calls = 0;
    const release = f.store.release;
    f.store.release = (key, holder) => interrupted ? Promise.resolve() : release(key, holder);
    Date.now = () => now;
    f.mock((body) => {
      calls++;
      if (interrupted) throw new Error('合成进程中断');
      return sse(body, '恢复后的合成回答', 'p');
    });
    const req: AnthropicRequest = {
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: crypto.randomUUID() }],
    };
    const owner = crypto.randomUUID(), started = now;
    try {
      try {
        await controller.runSiderController(req, owner);
      } catch { /* 模拟锁未释放 */ }
      interrupted = false;
      for (const elapsed of [69_999, 70_000, 104_999]) {
        now = started + elapsed;
        let code: string | undefined;
        try {
          await controller.runSiderController(req, owner);
        } catch (error) {
          code = (error as controller.ControllerError).code;
        }
        equal(code, 'controller_busy');
      }
      now = started + 105_000;
      const fresh = await f.restart();
      const response = await fresh.runSiderController(req, owner);
      equal(response.content.find((block) => block.type === 'text')?.text, '恢复后的合成回答');
      equal(calls, 2);
    } finally {
      Date.now = originalNow;
    }
  });
});

Deno.test('请求锁期限：正常异常仍立即释放锁，无需等待 TTL', async () => {
  await fixture(async (f) => {
    let calls = 0;
    f.mock((body) => {
      if (++calls === 1) throw new Error('合成普通异常');
      return sse(body, '恢复后的合成回答', 'p');
    });
    const req: AnthropicRequest = {
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: crypto.randomUUID() }],
    };
    const owner = crypto.randomUUID();
    try {
      await controller.runSiderController(req, owner);
    } catch { /* 下一次可立即重试 */ }
    await controller.runSiderController(req, owner);
    equal(calls, 2);
  });
});

Deno.test('请求锁期限：账号重选共用原始截止时间，不能重新获得70秒', async () => {
  await fixture(async (f) => {
    Deno.env.set('DENO_DEPLOYMENT_ID', 'fixture-deployment');
    Deno.env.delete('SIDER_TOTAL_TIMEOUT_MS');
    f.mock((body) => sse(body, '合成回答', 'p'));
    const owner = crypto.randomUUID();
    const req: AnthropicRequest = {
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: crypto.randomUUID() }],
    };
    const first = await controller.runSiderController(req, owner);
    const session = first.sider_session!.conversation_id;
    const key = `${await controller.controllerHash(owner)}:task:${session}`;
    const task = (await f.store.read<Record<string, unknown>>(key))!;
    const { siderAccountId } = await import('../src/utils/sider-accounts.ts');
    task.account = await siderAccountId('fixture-account-2');
    await f.store.write(key, task, 600_000);
    Deno.env.set('SIDER_AUTH_TOKEN_1', 'fixture-account-2');
    const fresh = await f.restart();
    const originalNow = Date.now, originalTimeout = AbortSignal.timeout;
    let now = originalNow(), accountClaims = 0, calls = 0;
    const deadlines: { at: number; abort: AbortController }[] = [];
    const advance = (ms: number) => {
      now += ms;
      for (const entry of deadlines) {
        if (now >= entry.at) {
          entry.abort.abort(new DOMException('合成请求期限已到', 'TimeoutError'));
        }
      }
    };
    Date.now = () => now;
    AbortSignal.timeout = (ms) => {
      const abort = new AbortController();
      deadlines.push({ at: now + ms, abort });
      return abort.signal;
    };
    const claim = f.store.claim, release = f.store.release;
    f.store.claim = (key, holder, ttl) => {
      if (key.startsWith('account:') && ++accountClaims === 2) advance(15_000);
      return claim(key, holder, ttl);
    };
    f.store.release = async (key, holder) => {
      await release(key, holder);
      if (key.startsWith('account:') && accountClaims === 1) advance(60_000);
    };
    f.mock((body) => {
      calls++;
      return sse(body, '不应发送的超时回答', 'p');
    });
    try {
      let status: number | undefined;
      try {
        await fresh.runSiderController(
          { ...req, messages: [{ role: 'user', content: crypto.randomUUID() }] },
          owner,
          undefined,
          session,
        );
      } catch (error) {
        status = (error as controller.ControllerError).statusCode;
      }
      equal(status, 400);
      equal(deadlines.length, 1);
      equal(calls, 0);
    } finally {
      Date.now = originalNow;
      AbortSignal.timeout = originalTimeout;
    }
  });
});

Deno.test('上下文容量：超过512000字符的历史在KV重建后无损续传，已确认分片不重发', async () => {
  await fixture(async (f) => {
    const marker = crypto.randomUUID();
    const system = '<svg><text>历史页面😀</text></svg>\n'.repeat(18000) + marker;
    const req: AnthropicRequest = {
      ...request(),
      system,
      messages: [{ role: 'user', content: '请总结会话并保留尾部事实。' }],
    };
    const original = system + '\n\n请总结会话并保留尾部事实。';
    equal(original.length > 512000, true);
    const chunks: string[] = [];
    let interrupted = false;
    f.mock((body) => {
      const text = body.multi_content[0]!.text;
      const match = text.match(/^以下是当前任务上下文片段(\d+)\/(\d+)[^\n]*\n([\s\S]*)$/);
      if (match) {
        const index = Number(match[1]);
        if (index === 2 && !interrupted) {
          interrupted = true;
          return sse(body, '合成中断，尚未确认。', 'unconfirmed');
        }
        equal(index, chunks.length + 1);
        if (index > 1) equal(body.parent_message_id, `large-${index - 1}`);
        chunks.push(match[3]!);
        return sse(body, '已记住', `large-${index}`);
      }
      equal(chunks.join(''), original);
      return sse(body, marker, 'large-answer');
    });
    const owner = crypto.randomUUID();
    const first = await controllerResponse(req, owner, createRequestLogContext(req));
    equal(first.status, 502);
    equal((await first.json()).error.code, 'context_unconfirmed');
    const checkpoint = await f.checkpoint();
    equal(checkpoint.parent, 'large-1');
    equal(Object.values(checkpoint.uploads ?? {}), [1]);
    equal(
      await controller.readControllerText(
        f.store,
        `${await controller.controllerHash(
          owner,
        )}:${checkpoint.id}:upload:${checkpoint.pendingUpload}`,
      ),
      original,
    );
    const fresh = await f.restart();
    const result = await fresh.runSiderController(req, owner);
    equal(result.content.find((block) => block.type === 'text')?.text, marker);
    equal(chunks.join(''), original);
    equal((await f.checkpoint()).pendingUpload, undefined);
  });
});
