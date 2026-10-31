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
  nextSiderPaceGap,
  readControllerText,
  saveControllerText,
  strictControllerCalls,
} from '../src/utils/sider-controller.ts';
import { fetchSiderResponse } from '../src/utils/sider-transport.ts';
import { getSiderAccounts, siderAccountId } from '../src/utils/sider-accounts.ts';
import { validDeclaredToolInput } from '../src/utils/tool-input-validation.ts';
import type { AnthropicRequest } from '../src/types/anthropic.ts';
import { getSiderActivitySnapshot, resetSiderActivity } from '../src/utils/sider-activity.ts';
import { getUsageSnapshot, resetUsageStats } from '../src/utils/usage-stats.ts';

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
  fn: (body: any, init?: RequestInit) => Response | Promise<Response>,
  run: (app: Hono) => Promise<void>,
  extraEnv: Record<string, string> = {},
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
    ...extraEnv,
  };
  const prev = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    prev.set(key, Deno.env.get(key));
    Deno.env.set(key, value);
  }
  try {
    globalThis.fetch = (async (url, init) => {
      if (!String(url).includes('sider.ai')) throw new Error('主控不应调用GLM或其他上游');
      return await fn(JSON.parse(String(init?.body)), init);
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

Deno.test('P0主控：默认流式接管Read续轮，重放不再调用模型且统计实际模型', async () => {
  resetUsageStats();
  resetSiderActivity();
  let count = 0;
  await appWithMock(() => {
    count++;
    return sse(
      count === 1 ? '[tool_use:Read] id=p0_read input={"file_path":"p0.json"}' : '事实标记P0_OK',
      'p0-stream-cid',
    );
  }, async (app) => {
    Deno.env.delete('SIDER_CONTROLLER_STREAMING');
    const status = await (await app.request('/v1/messages/backends/status', { headers })).json();
    equal(status.routing.siderControllerStreaming, true);
    const request: AnthropicRequest = {
      model: 'claude-opus-5.5[1m]',
      stream: true,
      tools,
      messages: [{ role: 'user', content: crypto.randomUUID() }],
    };
    const firstResponse = await send(app, request);
    equal(firstResponse.headers.get('x-sider-controller'), 'true');
    const first = await firstResponse.text();
    equal(first.includes('"name":"Read"'), true);
    equal(first.includes('event: message_stop'), true);
    const call = first.split('\n').filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)))
      .find((event) => event.content_block?.type === 'tool_use').content_block;
    equal(
      await (await send(app, request)).text().then((text) => text.includes('"name":"Read"')),
      true,
    );
    equal(count, 1);
    const activity = await getSiderActivitySnapshot();
    equal(activity.totals.attempts, 1);
    equal(activity.totals.completed, 1);
    equal(activity.totals.cachedReplays, 1);
    equal(getUsageSnapshot().totals.cachedReplays, 1);
    const recent = getUsageSnapshot().recent[0];
    equal(recent.actualModel, 'claude-opus-5.5');
    equal(recent.mode, 'controller');
    equal(recent.stream, true);
    const response = await send(app, {
      ...request,
      messages: [...request.messages, {
        role: 'assistant',
        content: [{ type: 'tool_use', id: call.id, name: 'Read', input: { file_path: 'p0.json' } }],
      }, {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: call.id, content: '事实标记P0_OK' }],
      }],
    });
    const result = await response.text();
    equal(result.includes('事实标记P0_OK'), true);
    equal(result.includes('event: error'), false);
    equal(count, 2);
  });
});

Deno.test('P0主控：没有fallback的1135及冷却拒绝也进入失败统计', async () => {
  resetSiderActivity();
  const store = await getControllerStore();
  const key = `cooldown:${await siderAccountId('controller-sider-token')}:claude-opus-5.5`;
  try {
    await appWithMock(
      () =>
        new Response(JSON.stringify({ code: 1135, msg: 'Please try again after 1 minutes.' }), {
          status: 400,
        }),
      async (app) => {
        for (let i = 0; i < 2; i++) {
          equal(
            (await send(app, {
              model: 'claude-opus-5.5',
              messages: [{ role: 'user', content: crypto.randomUUID() }],
            })).status,
            429,
          );
        }
        const activity = await getSiderActivitySnapshot();
        equal(activity.totals.attempts, 1);
        equal(activity.totals.failed, 1);
        equal(activity.totals.quotaErrors, 1);
        equal(activity.totals.requestFailures, 2);
        equal(activity.totals.cooldownRejections, 1);
        equal(activity.totals.completed, 0);
      },
    );
  } finally {
    await store.write(key, 0, -1);
  }
});

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
  const key = `cooldown:${await siderAccountId('controller-sider-token')}:claude-sonnet-5.5`;
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
      }, { role: 'user', content: '请继续完成' }],
    });

    equal(response.status, 200);
    equal((await response.json()).content[0].text, '已从检查点继续');
    equal(await store.read(`${owner}:tool:${toolUseId}`), first.sider_session.conversation_id);
    equal(count, 2);
  });
});
Deno.test('主控HTTP：无检查点的后台PowerShell结果从完整历史恢复，重试与后续工具不重放命令', async () => {
  const id = `native_${crypto.randomUUID()}`;
  const output = `C:/Temp/${id}.output`;
  const request: AnthropicRequest = {
    model: 'claude-opus-5.5',
    tools: [{
      name: 'TaskOutput',
      input_schema: {
        type: 'object',
        properties: { task_id: { type: 'string' } },
        required: ['task_id'],
      },
    }],
    messages: [
      { role: 'user', content: '根据生图后台任务输出继续完成，不要重新运行命令。' },
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id,
          name: 'PowerShell',
          input: {
            command:
              'python skills/ppt-master/scripts/image_gen.py --manifest projects/demo/images/image_prompts.json --output projects/demo/images',
            description: 'Generate AI images from manifest',
            timeout: 600000,
          },
        }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: id,
          content:
            `Command running in background with ID: blvuwvc0a. Output is being written to: ${output}`,
        }],
      },
      { role: 'user', content: '请继续完成' },
    ],
  };
  let count = 0;
  await appWithMock((body) => {
    count++;
    const text = body.multi_content[0].text;
    if (count === 1) {
      equal(body.cid, '');
      equal(body.parent_message_id, undefined);
      for (
        const value of [
          'image_gen.py --manifest',
          output,
          'blvuwvc0a',
          '请继续完成',
          `tool_use_id=${id}`,
        ]
      ) {
        equal(text.includes(value), true);
      }
      return sse(
        '[tool_use:TaskOutput] id=poll_1 input={"task_id":"blvuwvc0a"}',
        'recovered-cid',
        'recovered-parent-1',
      );
    }
    equal(body.cid, 'recovered-cid');
    equal(body.parent_message_id, 'recovered-parent-1');
    equal(text.includes('tool_use_id=poll_1'), true);
    equal(text.includes('图片已生成'), true);
    equal(text.includes('image_gen.py'), false);
    return sse('图片已生成，任务完成', 'recovered-cid', 'recovered-parent-2');
  }, async (app) => {
    const response = await send(app, request);
    equal(response.status, 200);
    const first = await response.json();
    equal(first.content[0].name, 'TaskOutput');
    equal(first.content[0].input, { task_id: 'blvuwvc0a' });
    const replay = await (await send(app, request)).json();
    equal(replay.id, first.id);
    equal(count, 1);
    const next = await send(app, {
      ...request,
      messages: [...request.messages, { role: 'assistant', content: first.content }, {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: first.content[0].id, content: '图片已生成' }],
      }],
    });
    equal(next.status, 200);
    equal((await next.json()).stop_reason, 'end_turn');
    equal(count, 2);
  });
});
Deno.test('主控HTTP：过期检查点以配对历史恢复，错误结果与流式协议完整保留', async () => {
  const id = `expired_${crypto.randomUUID()}`;
  const owner = await controllerHash('controller-test-token');
  const store = await getControllerStore();
  await store.write(`${owner}:tool:${id}`, 'missing-task', 60_000);
  await appWithMock((body) => {
    equal(body.cid, '');
    equal(body.multi_content[0].text.includes('is_error=true'), true);
    equal(body.multi_content[0].text.includes('生图后端未配置'), true);
    return sse('生图后端未配置，需要先配置后端', 'expired-recovered-cid');
  }, async (app) => {
    const response = await send(app, {
      model: 'claude-opus-5.5',
      stream: true,
      messages: [
        {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id,
            name: 'PowerShell',
            input: { command: 'python image_gen.py' },
          }],
        },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: id,
            is_error: true,
            content: [{ type: 'text', text: '生图后端未配置' }],
          }],
        },
      ],
    });
    const stream = await response.text();
    equal(stream.includes('event: error'), false);
    equal(stream.includes('生图后端未配置'), true);
    equal(stream.includes('event: message_stop'), true);
    equal(await store.read(`${owner}:tool:${id}`) !== 'missing-task', true);
  });
});
Deno.test('主控HTTP：历史恢复拒绝孤立、错配、重复及缺失结果，不调用上游', async () => {
  const call = {
    type: 'tool_use' as const,
    id: `invalid_${crypto.randomUUID()}`,
    name: 'PowerShell',
    input: { command: 'echo ok' },
  };
  const result = { type: 'tool_result' as const, tool_use_id: call.id, content: 'ok' };
  const histories: AnthropicRequest['messages'][] = [
    [{ role: 'user', content: [result] }],
    [{ role: 'assistant', content: [call] }, {
      role: 'user',
      content: [{ ...result, tool_use_id: 'foreign' }],
    }],
    [{ role: 'assistant', content: [call] }, { role: 'user', content: [result, result] }],
    [{ role: 'assistant', content: [call, call] }, { role: 'user', content: [result] }],
    [{ role: 'assistant', content: [call, { ...call, id: 'missing-result' }] }, {
      role: 'user',
      content: [result],
    }],
    [{ role: 'assistant', content: [call] }, { role: 'user', content: [result] }, {
      role: 'assistant',
      content: '已处理',
    }, { role: 'user', content: [result] }],
  ];
  await appWithMock(() => {
    throw new Error('无效历史不应请求上游');
  }, async (app) => {
    for (const messages of histories) {
      const response = await send(app, { model: 'claude-opus-5.5', messages });
      equal(response.status, 400);
    }
  });
});
Deno.test('主控HTTP：历史恢复不能绕过已有任务的跨任务、会话冲突或已处理结果检查', async () => {
  let count = 0;
  await appWithMock(() => {
    count++;
    return sse(
      count <= 2 ? '[tool_use:Read] id=read_1 input={"file_path":"resume.txt"}' : '已读取',
      `guard-cid-${count}`,
    );
  }, async (app) => {
    const request: AnthropicRequest = {
      model: 'claude-opus-5.5',
      tools,
      messages: [{ role: 'user', content: '读取文件-' + crypto.randomUUID() }],
    };
    const first = await (await send(app, request)).json();
    const other = await (await send(app, {
      ...request,
      messages: [{ role: 'user', content: '另一任务-' + crypto.randomUUID() }],
    })).json();
    const result = {
      type: 'tool_result' as const,
      tool_use_id: first.content[0].id,
      content: '文件正文',
    };
    const next: AnthropicRequest = {
      ...request,
      messages: [...request.messages, { role: 'assistant', content: first.content }, {
        role: 'user',
        content: [result],
      }],
    };
    const mixed = await send(app, {
      ...next,
      messages: [...request.messages, {
        role: 'assistant',
        content: [...first.content, ...other.content],
      }, { role: 'user', content: [result, { ...result, tool_use_id: other.content[0].id }] }],
    });
    equal(mixed.status, 400);
    const conflict = await app.request('/v1/messages', {
      method: 'POST',
      headers: { ...headers, 'x-conversation-id': other.sider_session.conversation_id },
      body: JSON.stringify(next),
    });
    equal(conflict.status, 400);
    equal(count, 2);
    equal((await send(app, next)).status, 200);
    const consumed = await send(app, {
      ...next,
      messages: [...next.messages, { role: 'user', content: '请继续完成' }],
    });
    equal(consumed.status, 400);
    equal(count, 3);
  });
});
Deno.test('主控HTTP：完整的历史并行工具轮恢复时保留每项结果及错误标记', async () => {
  const id = crypto.randomUUID();
  await appWithMock((body) => {
    equal(body.cid, '');
    const text = body.multi_content[0].text;
    for (
      const value of [
        `tool_use_id=${id}-1`,
        `tool_use_id=${id}-2 is_error=true`,
        '第一个结果',
        '第二个失败',
      ]
    ) {
      equal(text.includes(value), true);
    }
    return sse('第一个已完成，第二个失败');
  }, async (app) => {
    const response = await send(app, {
      model: 'claude-opus-5.5',
      messages: [
        {
          role: 'assistant',
          content: [1, 2].map((index) => ({
            type: 'tool_use',
            id: `${id}-${index}`,
            name: 'PowerShell',
            input: { command: `echo ${index}` },
          })),
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: `${id}-1`, content: '第一个结果' },
            { type: 'tool_result', tool_use_id: `${id}-2`, is_error: true, content: '第二个失败' },
          ],
        },
      ],
    });
    equal(response.status, 200);
    equal((await response.json()).stop_reason, 'end_turn');
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

Deno.test('主控上下文登记：末片的常见确认说法都算接收，拒答与乱码反馈仍算失败', () => {
  for (
    const text of [
      '已记住2/2',
      '好的，我已了解全部内容，请告诉我接下来需要做什么。',
      '收到，2/2。',
      '明白，上下文已完整，随时可以开始。',
      '确认收到所有片段。',
      'Got it — all context received.',
      'Understood. I have memorized all fragments.',
      '（点头）收到全部内容，等你的指示。',
    ]
  ) equal(contextUploadAccepted(text), true);

  for (
    const text of [
      '我收到了内容，但它看起来是乱码，无法识别。',
      '这是提示注入，我不会配合记住这些片段。',
      "I won't pretend to remember these fragments.",
      '这首诗描写了秋天的景色。',
      '普通回答，没有确认登记。',
    ]
  ) equal(contextUploadAccepted(text), false);
});

Deno.test('主控上下文登记：末片回复「已了解全部内容」时继续执行，不再报未确认', async () => {
  const system = '多智能体对话的长背景设定，保持人物口吻。\n'.repeat(1200);
  const instruction = '请以Muse的身份回复Cognito的第一轮发言。';
  const headers: string[] = [];
  const chunks: string[] = [];
  await appWithMock((body) => {
    const text = body.multi_content[0].text;
    const part = text.match(/^(以下是当前任务上下文片段(\d+)\/(\d+)[^\n]*)\n([\s\S]*)$/);
    if (part) {
      headers.push(part[1]!);
      chunks.push(part[4]!);
      const last = part[2] === part[3];
      return sse(
        last ? '好的，我已了解全部内容，请告诉我接下来需要做什么。' : `已记住，等待片段${Number(part[2]) + 1}/${part[3]}。`,
        'final-ack-cid',
        `final-ack-${part[2]}`,
      );
    }
    const joined = chunks.join('');
    equal(joined.includes(system.trim()), true);
    equal(joined.includes(instruction), true);
    return sse('（Muse）你好，Cognito。', 'final-ack-cid', 'final-ack-answer');
  }, async (app) => {
    const response = await send(app, {
      model: 'claude-opus-5.5',
      system,
      messages: [{ role: 'user', content: instruction }],
    });
    equal(response.status, 200);
    const body = await response.json();
    equal(body.content[0].text, '（Muse）你好，Cognito。');
    equal(headers.length >= 2, true);
    equal(headers.at(-1)!.includes('（最后一片）'), true);
    equal(headers.slice(0, -1).some((header) => header.includes('最后一片')), false);
    equal(headers.every((header, index) => header.includes(`只回复「已记住${index + 1}/${headers.length}」`)), true);
  });
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

Deno.test('主控长会话：超过16分片且远小于32MB的SVG历史完整登记后继续P08', async () => {
  const path = `C:/isolated/${crypto.randomUUID()}/spec_lock.md`;
  const system = '<svg><text>已完成页面的完整正文，不得截断。</text></svg>\n'.repeat(2500) +
    `\n尾部唯一规范路径：${path}`;
  const instruction = 'P07已完成。现在按规范指定的唯一路径调用Read，继续P08德国。';
  const chunks: string[] = [];
  let expectedCount = 0;
  await appWithMock((body) => {
    const text = body.multi_content[0].text;
    equal(text.length <= 6000, true);
    const part = text.match(/^以下是当前任务上下文片段(\d+)\/(\d+)[^\n]*\n([\s\S]*)$/);
    if (part) {
      equal(Number(part[1]), chunks.length + 1);
      expectedCount = Number(part[2]);
      chunks.push(part[3]);
      return sse('已记住', 'long-svg-cid', `long-svg-${part[1]}`);
    }
    equal(expectedCount > 16, true);
    equal(chunks.length, expectedCount);
    equal(chunks.join(''), `${system}\n\n${instruction}`);
    return sse(
      `[tool_use:Read] id=p08 input=${JSON.stringify({ file_path: path })}`,
      'long-svg-cid',
    );
  }, async (app) => {
    const request: AnthropicRequest = {
      model: 'claude-opus-5.5',
      tools: [tools![0]!],
      system,
      messages: [{ role: 'user', content: instruction }],
    };
    equal(new TextEncoder().encode(JSON.stringify(request)).length < 32 * 1024 * 1024, true);
    const response = await send(app, request);
    equal(response.status, 200);
    equal((await response.json()).content[0].input.file_path, path);
  });
});
Deno.test('主控长会话：上传中断后追加请继续，先续传原始尾部再执行，不重发已确认分片', async () => {
  const id = `native_read_${crypto.randomUUID()}`;
  const path = `C:/isolated/${id}/08.svg`;
  const seen = new Map<number, string>();
  let total = 0;
  let failed = false;
  const request: AnthropicRequest = {
    model: 'claude-opus-5.5',
    tools: [tools![0]!],
    system: '必须保留完整SVG及规范。\n'.repeat(1800) + `尾部唯一下一页路径：${path}`,
    messages: [
      { role: 'user', content: 'P07完成，读取规范后继续P08。' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: 'spec_lock.md' } }],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: '已读取规范' }] },
    ],
  };
  await appWithMock((body) => {
    const text = body.multi_content[0].text;
    const part = text.match(/^以下是当前任务上下文片段(\d+)\/(\d+)[^\n]*\n([\s\S]*)$/);
    if (part) {
      const index = Number(part[1]);
      total = Number(part[2]);
      if (index === 2 && !failed) {
        failed = true;
        return new Response('temporary upstream failure', { status: 503 });
      }
      equal(seen.has(index), false);
      if (index > 1) equal(body.parent_message_id, `resume-parent-${index - 1}`);
      seen.set(index, part[3]);
      return sse('已记住', 'resume-context-cid', `resume-parent-${index}`);
    }
    equal(seen.size, total);
    equal([...seen.values()].join('').includes(path), true);
    equal(text.includes('请继续完成P08'), true);
    return sse(
      `[tool_use:Read] id=p08 input=${JSON.stringify({ file_path: path })}`,
      'resume-context-cid',
    );
  }, async (app) => {
    equal((await send(app, request)).status, 502);
    equal(seen.size, 1);
    const response = await send(app, {
      ...request,
      messages: [...request.messages, { role: 'user', content: '请继续完成P08' }],
    });
    equal(response.status, 200);
    equal((await response.json()).content[0].input.file_path, path);
    equal(seen.size, total);
  });
});
Deno.test('主控长会话：内部内容库超限显示实际容量错误，不伪装成HTTP32MB限制', async () => {
  await appWithMock(() => {
    throw new Error('容量校验失败不应调用上游');
  }, async (app) => {
    const response = await send(app, {
      model: 'claude-opus-5.5',
      system: 'x'.repeat(512001),
      messages: [{ role: 'user', content: crypto.randomUUID() }],
    });
    equal(response.status, 400);
    const body = await response.json();
    equal(body.error.type, 'invalid_request_error');
    equal(body.error.message.includes('512000'), true);
  });
});
Deno.test('主控部署期限：非流式分批返回可重试进度，纯用户追加继续仍续传同一原文', async () => {
  resetSiderActivity();
  const previous = Deno.env.get('DENO_DEPLOYMENT_ID');
  Deno.env.set('DENO_DEPLOYMENT_ID', 'context-batch-test');
  const path = `C:/isolated/${crypto.randomUUID()}/spec_lock.md`;
  const seen = new Map<number, string>();
  let total = 0, inRequest = 0, inputTokens = 0, outputTokens = 0;
  const request: AnthropicRequest = {
    model: 'claude-opus-5.5',
    tools: [tools![0]!],
    system: '完整部署规范。'.repeat(2800) + `尾部唯一路径：${path}`,
    messages: [{ role: 'user', content: 'P07已完成，按尾部规范路径调用Read继续P08。' }],
  };
  try {
    await appWithMock((body) => {
      const text = body.multi_content[0].text;
      const part = text.match(/^以下是当前任务上下文片段(\d+)\/(\d+)[^\n]*\n([\s\S]*)$/);
      // 最后一批登记之后的执行调用也消耗同一请求预算。
      if (++inRequest > 2) return new Response('DEPLOYMENT_TIMED_OUT', { status: 503 });
      if (part) {
        const index = Number(part[1]);
        total = Number(part[2]);
        equal(seen.has(index), false);
        if (index > 1) equal(body.parent_message_id, `batch-parent-${index - 1}`);
        seen.set(index, part[3]);
        inputTokens += Math.ceil(text.length / 4);
        outputTokens++;
        return sse('已记住', 'batch-context-cid', `batch-parent-${index}`);
      }
      equal(seen.size, total);
      equal([...seen.values()].join('').includes(path), true);
      equal(text.includes('请继续完成P08'), true);
      const reply = `[tool_use:Read] id=p08 input=${JSON.stringify({ file_path: path })}`;
      inputTokens += Math.ceil(text.length / 4);
      outputTokens += Math.ceil(reply.length / 4);
      return sse(reply, 'batch-context-cid');
    }, async (app) => {
      let completed = false;
      for (let attempt = 0; attempt < 6; attempt++) {
        inRequest = 0;
        const response = await send(app, request);
        const result = await response.json();
        if (response.status === 429) {
          equal(response.headers.get('retry-after'), '1');
          equal(result.error.message.includes('登记进度'), true);
          request.messages.push({ role: 'user', content: '请继续完成P08' });
          continue;
        }
        equal(response.status, 200);
        equal(result.content[0].input.file_path, path);
        equal(result.usage.input_tokens, inputTokens);
        equal(result.usage.output_tokens, outputTokens);
        const store = await getControllerStore();
        const task = await store.read<{ pendingHistory?: string; pendingUpload?: string }>(
          `${await controllerHash(
            'controller-test-token',
          )}:task:${result.sider_session.conversation_id}`,
        );
        equal(task?.pendingHistory, undefined);
        equal(task?.pendingUpload, undefined);
        completed = true;
        break;
      }
      equal(completed, true);
      equal(total > 2, true);
      equal(total % 2, 0);
      const activity = await getSiderActivitySnapshot();
      equal(activity.totals.attempts, total + 1);
      equal(activity.totals.contextUploads, total);
      equal(activity.totals.completed, 1);
      equal(activity.totals.requestFailures, 0);
      equal(activity.totals.checkpointResponses > 0, true);
    });
  } finally {
    if (previous === undefined) Deno.env.delete('DENO_DEPLOYMENT_ID');
    else Deno.env.set('DENO_DEPLOYMENT_ID', previous);
  }
});
Deno.test('主控部署期限：节奏等待可被请求期限取消，保存原文后返回继续登记而非平台超时', async () => {
  const previous = {
    deployment: Deno.env.get('DENO_DEPLOYMENT_ID'),
    total: Deno.env.get('SIDER_TOTAL_TIMEOUT_MS'),
  };
  Deno.env.set('DENO_DEPLOYMENT_ID', 'context-deadline-test');
  Deno.env.set('SIDER_TOTAL_TIMEOUT_MS', '60');
  try {
    await appWithMock(() => {
      throw new Error('等待期应在调用上游前被取消');
    }, async (app) => {
      const store = await getControllerStore();
      const key = `pace:${await siderAccountId('controller-sider-token')}:claude-opus-5.5`;
      const previousPace = await store.read<{ nextAt: number; gapMs: number }>(key);
      await store.write(key, { nextAt: Date.now() + 10_000, gapMs: 12_000 }, 60_000);
      try {
        const started = Date.now();
        const response = await send(app, {
          model: 'claude-opus-5.5',
          system: '上下文'.repeat(6000),
          messages: [{ role: 'user', content: crypto.randomUUID() }],
        });
        equal(response.status, 429);
        equal(response.headers.get('retry-after'), '1');
        equal((await response.json()).error.message.includes('本次时限'), true);
        equal(Date.now() - started < 2000, true);
      } finally {
        await store.write(key, previousPace, previousPace === null ? -1 : 60_000);
      }
    });
  } finally {
    for (
      const [key, value] of [['DENO_DEPLOYMENT_ID', previous.deployment], [
        'SIDER_TOTAL_TIMEOUT_MS',
        previous.total,
      ]]
    ) {
      if (value === undefined) Deno.env.delete(key!);
      else Deno.env.set(key!, value);
    }
  }
});
Deno.test('主控部署期限：已开始响应的流式登记不受非流式批次限制', async () => {
  const previous = Deno.env.get('DENO_DEPLOYMENT_ID');
  Deno.env.set('DENO_DEPLOYMENT_ID', 'context-stream-test');
  let chunks = 0;
  try {
    await appWithMock((body) => {
      if (/^以下是当前任务上下文片段/.test(body.multi_content[0].text)) {
        chunks++;
        return sse('已记住', 'batch-stream-cid');
      }
      return sse('[tool_use:Read] id=p08 input={"file_path":"spec_lock.md"}', 'batch-stream-cid');
    }, async (app) => {
      const response = await send(app, {
        model: 'claude-opus-5.5',
        stream: true,
        tools: [tools![0]!],
        system: '完整流式规范。'.repeat(2300),
        messages: [{ role: 'user', content: 'Read读取spec_lock.md' }],
      });
      const stream = await response.text();
      equal(chunks > 2, true);
      equal(stream.includes('event: error'), false);
      equal(stream.includes('event: message_stop'), true);
      equal(stream.includes('"type":"tool_use"'), true);
    });
  } finally {
    if (previous === undefined) Deno.env.delete('DENO_DEPLOYMENT_ID');
    else Deno.env.set('DENO_DEPLOYMENT_ID', previous);
  }
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

Deno.test('主控节奏：空闲无固定等待，1101 翻倍上探，成功快速回落且受上下限约束', () => {
  // 空闲起步：没有历史碰撞时不产生任何等待。
  equal(nextSiderPaceGap(0, 'ok', 0, 12_000), 0);
  // 同一模型并发碰撞后逐级拉长（实测两路并发必有一路 1101）。
  equal(nextSiderPaceGap(0, 'concurrency', 0, 12_000), 1_000);
  equal(nextSiderPaceGap(1_000, 'concurrency', 0, 12_000), 2_000);
  // 上限封顶，避免把退避无限放大。
  equal(nextSiderPaceGap(8_000, 'concurrency', 0, 12_000), 12_000);
  // 成功后快速回落，几轮就回到 0，不把偶发碰撞变成长期限速。
  equal(nextSiderPaceGap(12_000, 'ok', 0, 12_000), 5_750);
  equal(nextSiderPaceGap(5_750, 'ok', 0, 12_000), 2_625);
  equal(nextSiderPaceGap(281, 'ok', 0, 12_000), 0);
  // 下限生效；非并发错误保持当前节奏。
  equal(nextSiderPaceGap(500, 'ok', 500, 12_000), 500);
  equal(nextSiderPaceGap(5_000, 'other', 0, 12_000), 5_000);
  // 配置上限为 0 等价于关闭节奏，测试环境依赖这一点。
  equal(nextSiderPaceGap(0, 'concurrency', 0, 0), 0);
});

Deno.test('主控租约：不同模型可并行，同一模型严格串行', async () => {
  resetSiderActivity();
  let inFlight = 0;
  let maxInFlight = 0;
  await appWithMock(async (body) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 120));
    inFlight--;
    return sse('OK', `lease-${crypto.randomUUID()}`, crypto.randomUUID(), body.model);
  }, async (app) => {
    const request = (model: string) =>
      send(app, {
        model,
        max_tokens: 20,
        messages: [{ role: 'user', content: `租约探针-${crypto.randomUUID()}` }],
      });

    // 实测不同模型可同时执行：租约必须按模型拆开。
    const [a, b] = await Promise.all([
      request('claude-opus-5.5'),
      request('claude-haiku-5.5'),
    ]);
    equal([a.status, b.status], [200, 200]);
    equal(maxInFlight, 2);

    // 同一模型只有一路并发额度：第二个请求等待租约，不能同时打上游。
    maxInFlight = 0;
    const [c, d] = await Promise.all([
      request('claude-sonnet-5.5'),
      request('claude-sonnet-5.5'),
    ]);
    equal([c.status, d.status], [200, 200]);
    equal(maxInFlight, 1);
  });
});

Deno.test('账号池：读取主账号与编号账号，去重、忽略空值、最多8个', async () => {
  const keys = [
    'SIDER_AUTH_TOKEN',
    ...Array.from({ length: 9 }, (_, i) => `SIDER_AUTH_TOKEN_${i + 1}`),
  ];
  const previous = new Map(keys.map((key) => [key, Deno.env.get(key)]));
  for (const key of keys) Deno.env.delete(key);
  try {
    Deno.env.set('SIDER_AUTH_TOKEN', 'token-primary');
    Deno.env.set('SIDER_AUTH_TOKEN_1', 'token-a');
    Deno.env.set('SIDER_AUTH_TOKEN_2', 'token-a');
    Deno.env.set('SIDER_AUTH_TOKEN_3', '');
    const accounts = await getSiderAccounts();
    equal(accounts.length, 2);
    equal(accounts.map((account) => account.primary), [true, false]);
    // id 只由账号身份决定：重复读取稳定，且与明文 token 无关。
    equal(accounts[0].id, (await getSiderAccounts())[0].id);
    equal(accounts[0].id === accounts[1].id, false);

    // 同一 Sider 账号的两个 token（JWT user_id 相同）必须归并为一个账号：
    // 实测它们并发仍返回 1101，不能当成两路额度。
    const jwt = (userId: string) => {
      const encode = (value: object) =>
        btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      return `${encode({ alg: 'none' })}.${encode({ user_id: userId })}.sig`;
    };
    Deno.env.set('SIDER_AUTH_TOKEN', jwt('user-1'));
    Deno.env.set('SIDER_AUTH_TOKEN_1', jwt('user-1'));
    Deno.env.set('SIDER_AUTH_TOKEN_2', jwt('user-2'));
    equal((await getSiderAccounts()).length, 2);

    for (let index = 1; index <= 9; index++) {
      Deno.env.set(`SIDER_AUTH_TOKEN_${index}`, `token-${index}`);
    }
    equal((await getSiderAccounts()).length, 8);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
});

Deno.test('账号池：同模型并发用满两个账号，同一会话续轮固定在原账号', async () => {
  resetSiderActivity();
  const used: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  await appWithMock(async (body, init) => {
    used.push(String((init?.headers as Record<string, string>)?.Authorization));
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 120));
    inFlight--;
    return sse('OK', `pool-${crypto.randomUUID()}`, crypto.randomUUID(), body.model);
  }, async (app) => {
    const request = (content: string, cid?: string) =>
      app.request(`/v1/messages${cid ? `?cid=${cid}` : ''}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: 'claude-sonnet-5.5',
          max_tokens: 20,
          messages: [{ role: 'user', content }],
        }),
      });

    // 两个账号让同模型的两路请求同时进入上游。
    const [a, b] = await Promise.all([
      request(`池-a-${crypto.randomUUID()}`),
      request(`池-b-${crypto.randomUUID()}`),
    ]);
    equal([a.status, b.status], [200, 200]);
    equal(maxInFlight, 2);
    equal(new Set(used.slice(-2)).size, 2);

    // 同一会话的下一轮必须沿用建立 cid 的账号。
    const first = await request(`会话首轮-${crypto.randomUUID()}`);
    const firstBody = await first.json();
    const firstToken = used.at(-1);
    const cid = firstBody.sider_session.conversation_id;
    const second = await request(`会话续轮-${crypto.randomUUID()}`, cid);
    equal(second.status, 200);
    equal(used.at(-1), firstToken);
  }, { SIDER_AUTH_TOKEN_1: 'controller-sider-token-2' });
});

Deno.test('账号池：任务绑定的账号被移除后明确报错，不改投其他账号', async () => {
  resetSiderActivity();
  const used: string[] = [];
  await appWithMock(async (body, init) => {
    used.push(String((init?.headers as Record<string, string>)?.Authorization));
    return sse('OK', `pinned-${crypto.randomUUID()}`, crypto.randomUUID(), body.model);
  }, async (app) => {
    const first = await send(app, {
      model: 'claude-opus-5.5',
      max_tokens: 20,
      messages: [{ role: 'user', content: `绑定-${crypto.randomUUID()}` }],
    });
    const body = await first.json();
    const token = used.at(-1)!.replace(/^Bearer /, '');
    for (const key of ['SIDER_AUTH_TOKEN', 'SIDER_AUTH_TOKEN_1']) {
      if (Deno.env.get(key) === token) Deno.env.delete(key);
    }
    const second = await app.request(`/v1/messages?cid=${body.sider_session.conversation_id}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'claude-opus-5.5',
        max_tokens: 20,
        messages: [{ role: 'user', content: `续轮-${crypto.randomUUID()}` }],
      }),
    });
    equal(second.status, 503);
    equal((await second.json()).error.message.includes('Sider账号'), true);
  }, { SIDER_AUTH_TOKEN_1: 'controller-sider-token-2' });
});

Deno.test('账号池：按token哈希写下的旧绑定自动迁移到账号身份键', async () => {
  resetSiderActivity();
  const used: string[] = [];
  await appWithMock(async (body, init) => {
    used.push(String((init?.headers as Record<string, string>)?.Authorization));
    return sse('OK', `legacy-${crypto.randomUUID()}`, crypto.randomUUID(), body.model);
  }, async (app) => {
    const first = await send(app, {
      model: 'claude-opus-5.5',
      max_tokens: 20,
      messages: [{ role: 'user', content: `旧绑定-${crypto.randomUUID()}` }],
    });
    const body = await first.json();
    const taskId = body.sider_session.conversation_id;
    const store = await getControllerStore();
    const owner = await controllerHash('controller-test-token');
    const key = `${owner}:task:${taskId}`;
    const task = await store.read<Record<string, unknown>>(key);
    const legacyId = await controllerHash(used.at(-1)!.replace(/^Bearer /, ''));
    await store.write(key, { ...task, account: legacyId }, 60_000);

    const second = await app.request(`/v1/messages?cid=${taskId}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'claude-opus-5.5',
        max_tokens: 20,
        messages: [{ role: 'user', content: `续轮-${crypto.randomUUID()}` }],
      }),
    });
    equal(second.status, 200);
    const migrated = await store.read<{ account?: string }>(key);
    equal(migrated?.account === legacyId, false);
  }, { SIDER_AUTH_TOKEN_1: 'controller-sider-token-2' });
});

Deno.test('主控流式：无工具请求实时下发文本增量', async () => {
  resetSiderActivity();
  const sseBody = (chunks: string[]) =>
    [
      {
        code: 0,
        msg: 'ok',
        data: {
          type: 'message_start',
          model: 'claude-opus-5.5',
          message_start: {
            cid: `stream-answer-${crypto.randomUUID()}`,
            user_message_id: 'u',
            assistant_message_id: crypto.randomUUID(),
          },
        },
      },
      ...chunks.map((text) => ({
        code: 0,
        msg: 'ok',
        data: { type: 'text', model: 'claude-opus-5.5', text },
      })),
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');

  await appWithMock(
    () =>
      new Response(sseBody(['第一段', '第二段']), {
        headers: { 'content-type': 'text/event-stream' },
      }),
    async (app) => {
      const response = await send(app, {
        model: 'claude-opus-5.5',
        stream: true,
        max_tokens: 50,
        messages: [{ role: 'user', content: `流式回答-${crypto.randomUUID()}` }],
      });
      equal(response.status, 200);
      const events = (await response.text())
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => JSON.parse(line.slice(6)));
      const deltas = events.filter((event) =>
        event.type === 'content_block_delta' && event.delta?.type === 'text_delta'
      );
      equal(deltas.length, 2);
      equal(deltas.map((event) => event.delta.text).join(''), '第一段第二段');
      equal(events.filter((event) => event.type === 'content_block_start').length, 1);
      equal(events.filter((event) => event.type === 'content_block_stop').length, 1);
      equal(events.find((event) => event.type === 'message_delta').delta.stop_reason, 'end_turn');
    },
  );
});

Deno.test('主控流式：带stop_sequences时保持整段缓冲并正确截断', async () => {
  resetSiderActivity();
  await appWithMock(
    () =>
      new Response(
        [
          {
            code: 0,
            msg: 'ok',
            data: {
              type: 'message_start',
              model: 'claude-opus-5.5',
              message_start: {
                cid: `stream-stop-${crypto.randomUUID()}`,
                user_message_id: 'u',
                assistant_message_id: crypto.randomUUID(),
              },
            },
          },
          {
            code: 0,
            msg: 'ok',
            data: { type: 'text', model: 'claude-opus-5.5', text: '一二三停止后面的内容' },
          },
        ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
    async (app) => {
      const response = await send(app, {
        model: 'claude-opus-5.5',
        stream: true,
        max_tokens: 50,
        stop_sequences: ['停止'],
        messages: [{ role: 'user', content: `停止序列-${crypto.randomUUID()}` }],
      });
      const events = (await response.text())
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => JSON.parse(line.slice(6)));
      const deltas = events.filter((event) =>
        event.type === 'content_block_delta' && event.delta?.type === 'text_delta'
      );
      equal(deltas.length, 1);
      equal(deltas[0].delta.text, '一二三');
      const final = events.find((event) => event.type === 'message_delta');
      equal(final.delta.stop_reason, 'stop_sequence');
      equal(final.delta.stop_sequence, '停止');
    },
  );
});

Deno.test('主控部署期限：非流式上游超时返回400并要求改用流式', async () => {
  resetSiderActivity();
  await appWithMock(
    (_body, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) throw new Error('缺少超时信号');
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    async (app) => {
      const response = await send(app, {
        model: 'claude-opus-5.5',
        max_tokens: 20,
        messages: [{ role: 'user', content: `超时-${crypto.randomUUID()}` }],
      });
      equal(response.status, 400);
      equal((await response.json()).error.message.includes('stream=true'), true);
    },
    { DENO_DEPLOYMENT_ID: 'timeout-test', SIDER_TOTAL_TIMEOUT_MS: '50' },
  );
});
