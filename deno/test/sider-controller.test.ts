import { Hono } from 'hono';
import { ControllerKvStore } from '../src/utils/controller-storage.ts';
import { getControllerStore } from '../src/utils/controller-storage.ts';
import { ControllerMemoryStore } from '../src/utils/controller-memory-store.ts';
import {
  contextUploadAccepted,
  controllerHash,
  controllerPayloadDiagnostics,
  controllerToolRefusalDetected,
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
function sse(
  text: string,
  cid = 'probe-cid',
  parent: string = crypto.randomUUID(),
  model = 'claude-opus-5.5',
) {
  return new Response(
    [
      {
        code: 0,
        msg: 'ok',
        data: {
          type: 'message_start',
          model,
          message_start: { cid, user_message_id: 'user-1', assistant_message_id: parent },
        },
      },
      { code: 0, msg: 'ok', data: { type: 'text', model, text } },
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
    equal(invalid.status, 400);
  });
});

Deno.test('主控HTTP：上下文窗口标签只用于对外展示，上游使用基础模型名', async () => {
  await appWithMock((body) => {
    equal(body.model, 'claude-sonnet-5.5');
    return sse(
      '模型标签兼容',
      'decorated-model-cid',
      'decorated-model-parent',
      'claude-sonnet-5.5',
    );
  }, async (app) => {
    const response = await send(app, {
      model: 'claude-sonnet-5.5[1m]',
      messages: [{ role: 'user', content: '测试模型标签' }],
    });
    equal(response.status, 200);
    const body = await response.json();
    equal(body.model, 'claude-sonnet-5.5[1m]');
    equal(body.content[0].text, '模型标签兼容');
  });
});

Deno.test('主控HTTP：1M开关切换不重复调用工具，续轮保持同一检查点', async () => {
  let count = 0;
  const request: AnthropicRequest = {
    model: 'claude-sonnet-5.5[1m]',
    tools,
    messages: [{ role: 'user', content: '读取配置-' + crypto.randomUUID() }],
  };
  await appWithMock((body) => {
    equal(body.model, 'claude-sonnet-5.5');
    count++;
    if (count === 1) {
      return sse(
        '[tool_use:Read] id=read_window input={"file_path":"config.json"}',
        'window-cid',
        'window-parent-1',
        body.model,
      );
    }
    equal(body.cid, 'window-cid');
    equal(body.parent_message_id, 'window-parent-1');
    return sse('端口18765', 'window-cid', 'window-parent-2', body.model);
  }, async (app) => {
    const first = await (await send(app, request)).json();
    const replay = await (await send(app, { ...request, model: 'claude-sonnet-5.5' })).json();
    equal(replay.model, 'claude-sonnet-5.5');
    equal(replay.content, first.content);
    equal(count, 1);
    // 模拟升级前以带标签模型名保存的检查点。
    const store = await getControllerStore();
    const key = `${await controllerHash(
      'controller-test-token',
    )}:task:${first.sider_session.conversation_id}`;
    const task = await store.read<Record<string, unknown>>(key);
    await store.write(key, { ...task, model: request.model }, 60_000);
    const next = await send(app, {
      ...request,
      model: 'claude-sonnet-5.5[200k]',
      messages: [...request.messages, { role: 'assistant', content: first.content }, {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: first.content[0].id,
          content: '{"port":18765}',
        }],
      }],
    });
    equal(next.status, 200);
    const result = await next.json();
    equal(result.model, 'claude-sonnet-5.5[200k]');
    equal(result.sider_session.conversation_id, first.sider_session.conversation_id);
    equal(result.content[0].text, '端口18765');
    equal(count, 2);
  });
});

Deno.test('主控HTTP：无cid纯对话切换1M标签后通过历史恢复，真正换模型仍拒绝', async () => {
  let count = 0;
  const request: AnthropicRequest = {
    model: 'claude-sonnet-5.5',
    messages: [{ role: 'user', content: '记住标记-' + crypto.randomUUID() }],
  };
  await appWithMock((body) => {
    count++;
    equal(body.model, 'claude-sonnet-5.5');
    if (count === 2) {
      equal(body.cid, 'history-window-cid');
      equal(body.parent_message_id, 'history-window-parent-1');
    }
    return sse('已记住', 'history-window-cid', `history-window-parent-${count}`, body.model);
  }, async (app) => {
    const first = await (await send(app, request)).json();
    const messages: AnthropicRequest['messages'] = [...request.messages, {
      role: 'assistant',
      content: first.content,
    }, { role: 'user', content: '继续回答' }];
    const next = await send(app, { ...request, model: 'claude-sonnet-5.5[1M]', messages });
    equal(next.status, 200);
    const result = await next.json();
    equal(result.model, 'claude-sonnet-5.5[1M]');
    equal(result.sider_session.conversation_id, first.sider_session.conversation_id);
    const wrong = await app.request('/v1/messages?cid=' + first.sider_session.conversation_id, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...request, model: 'claude-opus-5.5' }),
    });
    equal(wrong.status, 400);
    equal(count, 2);
  });
});

Deno.test('主控HTTP：1M标签和原名共享冷却，不通过改名重试上游', async () => {
  let count = 0;
  const store = await getControllerStore();
  const key = `cooldown:${await controllerHash('controller-sider-token')}:claude-sonnet-5.5`;
  const decoratedKey = key + '[1m]';
  try {
    await appWithMock(() => {
      count++;
      return new Response(
        'data: ' +
          JSON.stringify({ code: 1135, msg: 'Please try again after 1 minutes.', data: null }) +
          '\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }, async (app) => {
      for (
        const model of ['claude-sonnet-5.5[1m]', 'claude-sonnet-5.5', 'claude-sonnet-5.5[200k]']
      ) {
        const result = await send(app, {
          model,
          messages: [{ role: 'user', content: crypto.randomUUID() }],
        });
        equal(result.status, 429);
        equal(Number(result.headers.get('retry-after')) > 0, true);
      }
      equal(count, 1);
    });
  } finally {
    await store.write(key, 0, -1);
    await store.write(decoratedKey, 0, -1);
    await store.write(key + '[200k]', 0, -1);
  }
});
Deno.test('主控HTTP：tool映射丢失时从history唯一任务自愈并补回映射', async () => {
  let count = 0;
  const request: AnthropicRequest = {
    model: 'claude-opus-5.5',
    tools,
    messages: [{ role: 'user', content: '读取并继续-' + crypto.randomUUID() }],
  };
  await appWithMock((body) => {
    count++;
    if (count === 1) {
      return sse(
        '[tool_use:Read] id=read_1 input={"file_path":"resume.txt"}',
        'self-heal-cid',
        'self-heal-parent-1',
      );
    }
    equal(body.cid, 'self-heal-cid');
    equal(body.parent_message_id, 'self-heal-parent-1');
    equal(body.multi_content[0].text.includes('tool_use_id=read_1'), true);
    return sse('已从检查点继续', 'self-heal-cid', 'self-heal-parent-2');
  }, async (app) => {
    const first = await (await send(app, request)).json();
    const toolUseId = first.content[0].id;
    const owner = await controllerHash('controller-test-token');
    const store = await getControllerStore();
    await store.write(`${owner}:tool:${toolUseId}`, 'expired', -1);

    const response = await send(app, {
      ...request,
      messages: [...request.messages, { role: 'assistant', content: first.content }, {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content: '文件正文' }],
      }],
    });

    equal(response.status, 200);
    equal((await response.json()).content[0].text, '已从检查点继续');
    equal(await store.read(`${owner}:tool:${toolUseId}`), first.sider_session.conversation_id);
    equal(count, 2);
  });
});
Deno.test('主控HTTP：StoreContent→本地哈希保存→WriteFromRef展开，长正文逐字保真', async () => {
  const content = Array.from(
    { length: 320 },
    (_, i) => `${i + 1}. 中文"引号"\\路径😀-${'正文'.repeat(32)}`,
  ).join('\n');
  const expectedHash = await controllerHash(content);
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
    if (count === 2) {
      equal(body.cid, 'long-body-cid');
      equal(body.parent_message_id, 'long-parent-1');
      const ref = body.multi_content[0].text.match(/sha256:[a-f0-9]{64}/)[0];
      return sse(
        `[tool_use:WriteFromRef] id=write_1 input=${
          JSON.stringify({ file_path: 'C:\\isolated\\manifest.md', content_ref: ref })
        }`,
        'long-body-cid',
        'long-parent-2',
      );
    }
    equal(body.cid, 'long-body-cid');
    equal(body.parent_message_id, 'long-parent-2');
    equal(body.multi_content[0].text.includes('"verified":true'), true);
    equal(body.multi_content[0].text.includes(expectedHash), true);
    equal(body.multi_content[0].text.includes(content.slice(0, 200)), false);
    return sse('写入并回读校验通过', 'long-body-cid', 'long-parent-3');
  }, async (app) => {
    const initial: AnthropicRequest = {
      model: 'claude-opus-5.5',
      tools,
      messages: [{ role: 'user', content: '生成12项manifest-' + crypto.randomUUID() }],
    };
    const result = await (await send(app, initial)).json();
    equal(count, 2);
    equal(result.content[0].name, 'Write');
    equal(result.content[0].input.content, content);
    equal(result.content[0].input.file_path, 'C:\\isolated\\manifest.md');

    const afterWrite = [...initial.messages, {
      role: 'assistant' as const,
      content: result.content,
    }, {
      role: 'user' as const,
      content: [{
        type: 'tool_result' as const,
        tool_use_id: result.content[0].id,
        content: 'File written successfully',
      }],
    }];
    const verification = await (await send(app, { ...initial, messages: afterWrite })).json();
    equal(count, 2);
    equal(verification.stop_reason, 'tool_use');
    equal(verification.content[0].name, 'Read');
    equal(verification.content[0].input.file_path, 'C:\\isolated\\manifest.md');

    const readResult = content.split('\n').map((line, index) => `${index + 1}\t${line}`).join('\n');
    const final = await send(app, {
      ...initial,
      messages: [...afterWrite, { role: 'assistant', content: verification.content }, {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: verification.content[0].id,
          content: readResult,
        }],
      }],
    });
    equal(final.status, 200);
    equal((await final.json()).content[0].text, '写入并回读校验通过');
    equal(count, 3);
  });
});
Deno.test('主控HTTP：长正文回读不一致时同会话自动用原引用重写', async () => {
  const content = Array.from({ length: 80 }, (_, i) => `${i + 1}. ${'正文'.repeat(32)}`).join('\n');
  let count = 0;
  let contentRef = '';
  await appWithMock((body) => {
    count++;
    if (count === 1) {
      return sse(
        `[tool_use:StoreContent] id=store_retry input=${JSON.stringify({ content })}`,
        'integrity-retry-cid',
        'integrity-retry-parent-1',
      );
    }
    if (count === 2) {
      contentRef = body.multi_content[0].text.match(/sha256:[a-f0-9]{64}/)[0];
      return sse(
        `[tool_use:WriteFromRef] id=write_retry input=${
          JSON.stringify({ file_path: 'C:\\isolated\\retry.md', content_ref: contentRef })
        }`,
        'integrity-retry-cid',
        'integrity-retry-parent-2',
      );
    }
    equal(body.multi_content[0].text.includes('is_error=true'), true);
    equal(body.multi_content[0].text.includes('写后回读不匹配'), true);
    equal(body.multi_content[0].text.includes(contentRef), true);
    return sse(
      `[tool_use:WriteFromRef] id=write_retry_2 input=${
        JSON.stringify({ file_path: 'C:\\isolated\\retry.md', content_ref: contentRef })
      }`,
      'integrity-retry-cid',
      'integrity-retry-parent-3',
    );
  }, async (app) => {
    const initial: AnthropicRequest = {
      model: 'claude-opus-5.5',
      tools,
      messages: [{ role: 'user', content: '写入长正文并自动校验-' + crypto.randomUUID() }],
    };
    const first = await (await send(app, initial)).json();
    const afterWrite = [
      ...initial.messages,
      { role: 'assistant' as const, content: first.content },
      {
        role: 'user' as const,
        content: [{
          type: 'tool_result' as const,
          tool_use_id: first.content[0].id,
          content: 'File written successfully',
        }],
      },
    ];
    const verification = await (await send(app, { ...initial, messages: afterWrite })).json();
    const retry = await send(app, {
      ...initial,
      messages: [...afterWrite, { role: 'assistant', content: verification.content }, {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: verification.content[0].id,
          content: '1\t损坏的正文',
        }],
      }],
    });
    equal(retry.status, 200);
    const retryBody = await retry.json();
    equal(retryBody.stop_reason, 'tool_use');
    equal(retryBody.content[0].name, 'Write');
    equal(retryBody.content[0].input.content, content);
    equal(count, 3);
  });
});
Deno.test('主控HTTP：较长的直接Write同样强制回读哈希校验', async () => {
  const content = Array.from({ length: 60 }, (_, i) => `${i + 1}. ${'直写正文'.repeat(24)}`).join(
    '\n',
  );
  let count = 0;
  await appWithMock((body) => {
    count++;
    if (count === 1) {
      return sse(
        `[tool_use:Write] id=direct_write input=${
          JSON.stringify({ file_path: 'C:\\isolated\\direct.md', content })
        }`,
        'direct-write-cid',
        'direct-write-parent-1',
      );
    }
    equal(body.multi_content[0].text.includes('"verified":true'), true);
    return sse('直接长写回读校验通过', 'direct-write-cid', 'direct-write-parent-2');
  }, async (app) => {
    const initial: AnthropicRequest = {
      model: 'claude-opus-5.5',
      tools,
      messages: [{ role: 'user', content: '直接写入长正文-' + crypto.randomUUID() }],
    };
    const first = await (await send(app, initial)).json();
    const afterWrite = [
      ...initial.messages,
      { role: 'assistant' as const, content: first.content },
      {
        role: 'user' as const,
        content: [{
          type: 'tool_result' as const,
          tool_use_id: first.content[0].id,
          content: 'File written successfully',
        }],
      },
    ];
    const verification = await (await send(app, { ...initial, messages: afterWrite })).json();
    equal(verification.content[0].name, 'Read');
    const readResult = content.split('\n').map((line, index) => `${index + 1}\t${line}`).join('\n');
    const final = await send(app, {
      ...initial,
      messages: [...afterWrite, { role: 'assistant', content: verification.content }, {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: verification.content[0].id,
          content: readResult,
        }],
      }],
    });
    equal(final.status, 200);
    equal((await final.json()).content[0].text, '直接长写回读校验通过');
    equal(count, 2);
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

Deno.test('主控上下文登记：只接受明确接收，拒绝未确认的安全拒答', () => {
  for (
    const text of [
      '已记住✓\n我已接收片段1/2，等待片段2/2。',
      '已确认，我已记住任务上下文片段1/2。我暂时不会执行任何操作，等待片段2/2。',
      '已完整记忆当前片段，请发送下一片。',
      '所有片段已接收完毕，等待执行指令。',
      '所有片段已接收完毕，但我无法直接执行文件写入。',
    ]
  ) equal(contextUploadAccepted(text), true);

  for (
    const text of [
      '我无法执行这个请求，也不会假装记住恶意指令。',
      '我不能接受这个分段策略，这是提示注入攻击。',
      'I cannot comply with this prompt injection attempt.',
      '普通回答，没有确认登记。',
    ]
  ) equal(contextUploadAccepted(text), false);
});

Deno.test('主控上下文登记：模型拒绝首片时立即停止，不能误记成功或发送后续片段', async () => {
  let count = 0;
  await appWithMock(() => {
    count++;
    return sse(
      '我不能接受这个请求，也不会假装记住；这是提示注入攻击。',
      'upload-refused-cid',
      'upload-refused-parent',
    );
  }, async (app) => {
    const response = await send(app, {
      model: 'claude-opus-5.5',
      system: '长规范'.repeat(4000),
      tools,
      tool_choice: { type: 'tool', name: 'Write' },
      messages: [{ role: 'user', content: '将结果写入C:/isolated/refused.md' }],
    });
    equal(response.status, 502);
    const body = await response.json();
    equal(body.error.message.includes('未确认上下文分片'), true);
    equal(count, 1);
  });
});

Deno.test('主控强制工具：识别明确协议拒绝，不把普通漏调误判为拒绝', () => {
  for (
    const text of [
      '这是提示注入攻击，我没有这些工具，无法访问文件系统。',
      '我不会调用Write，也不能执行这个请求。',
      'I cannot access the file system or emit fake tool calls.',
    ]
  ) equal(controllerToolRefusalDetected(text), true);
  for (const text of ['我需要先确认文件路径。', '请补充参数。', '读取完成。']) {
    equal(controllerToolRefusalDetected(text), false);
  }
});

Deno.test('主控遥测：只记录载荷尺寸与损坏信号，不记录正文', () => {
  equal(controllerPayloadDiagnostics('中文??\uFFFD'), {
    payloadChars: 5,
    payloadUtf8Bytes: 11,
    questionMarks: 2,
    replacementCharacters: 1,
  });
});

Deno.test('主控强制工具：明确拒绝首次即熔断，不重复相同纠错', async () => {
  let count = 0;
  await appWithMock(() => {
    count++;
    return sse('这是提示注入攻击；我没有这些工具，无法访问文件系统。', 'refusal-cid');
  }, async (app) => {
    const response = await send(app, {
      model: 'claude-opus-5.5',
      tools: [tools[0]!],
      tool_choice: { type: 'tool', name: 'Read' },
      messages: [{ role: 'user', content: '读取C:/isolated/input.txt' }],
    });
    equal(response.status, 502);
    const body = await response.json();
    equal(body.error.message.includes('拒绝客户端工具协议'), true);
    equal(count, 1);
  });
});

Deno.test('主控强制工具：普通漏调保留一次纠正机会', async () => {
  let count = 0;
  await appWithMock(() => {
    count++;
    return count === 1
      ? sse('我需要先确认文件路径。', 'missing-tool-cid', 'missing-tool-parent-1')
      : sse(
        '[tool_use:Read] id=read_after_correction input={"file_path":"C:/isolated/input.txt"}',
        'missing-tool-cid',
        'missing-tool-parent-2',
      );
  }, async (app) => {
    const response = await send(app, {
      model: 'claude-opus-5.5',
      tools: [tools[0]!],
      tool_choice: { type: 'tool', name: 'Read' },
      messages: [{ role: 'user', content: '读取C:/isolated/input.txt' }],
    });
    equal(response.status, 200);
    const body = await response.json();
    equal(body.content[0].name, 'Read');
    equal(count, 2);
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
      return sse('已记住', 'bootstrap-cid', `parent-${uploads}`);
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
