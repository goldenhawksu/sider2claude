/**
 * Max 策略：Sider 承接工具调用。
 *
 * Sider 原生不提供 Anthropic `tool_use`，Max 靠往 prompt 注入文本工具契约实现
 * （probe 实测 sonnet-5：单轮 5/5、带引号命令 5/5、无需工具时不乱调 5/5、
 * 结果续轮不重复调 5/5、15 工具大 schema 5/5）。
 *
 * 本文件锁定四件事：契约确实被注入、文本调用被还原成 `tool_use` 且 `stop_reason`
 * 改判、**形状像调用却解析不出来**时抛错以触发 fallback、以及纯文本回答**不算失败**
 * ——最后一条最容易写反：契约明确允许模型不需要工具时直接作答，把它判成失败会
 * 把正常回答也兜底掉。
 */

import { Hono } from 'hono';
import type { AnthropicRequest } from '../src/types/anthropic.ts';
import { buildToolContract, restoreToolUseFromText } from '../src/utils/textual-tool-use.ts';
import { resetSiderThrottle } from '../src/utils/sider-throttle.ts';
import { resetSiderAvailability } from '../src/utils/sider-availability.ts';

function assertEquals<T>(actual: T, expected: T, what = '值') {
  if (actual !== expected) {
    throw new Error(`${what}：期望 ${String(expected)}，实际 ${String(actual)}`);
  }
}

function assert(condition: boolean, what: string) {
  if (!condition) throw new Error(`断言失败：${what}`);
}

const TOOLS: AnthropicRequest['tools'] = [{
  name: 'Bash',
  description: 'Run a shell command',
  input_schema: {
    type: 'object',
    properties: { command: { type: 'string' }, description: { type: 'string' } },
    required: ['command'],
  },
}] as unknown as AnthropicRequest['tools'];

function req(overrides: Partial<AnthropicRequest> = {}): AnthropicRequest {
  return {
    model: 'claude-sonnet-5',
    max_tokens: 1024,
    messages: [{ role: 'user', content: '列出当前目录' }],
    tools: TOOLS,
    ...overrides,
  } as AnthropicRequest;
}

Deno.test('Max 契约：点名格式、单调用、单行 JSON、不需要工具就别发', () => {
  const contract = buildToolContract(TOOLS);

  // 契约里点名的格式必须与解析器认识的格式一致，否则等于没约定
  assert(contract.includes('[tool_use:ToolName] id=call_'), '契约点名调用格式');
  assert(contract.includes('input={'), '契约点名 input 形态');
  // 工具清单要带完整 schema，模型才知道字段名
  assert(contract.includes('"Bash"'), '契约包含工具名');
  assert(contract.includes('"command"'), '契约包含 input_schema 字段');
  // 这三条规则各自撑着一个实测结论，缺一条就有对应的失效场景
  assert(contract.includes('at most one tool call'), '限制单次调用');
  assert(contract.includes('single line'), '限制单行 JSON');
  assert(contract.includes('If no tool is needed'), '允许不调用工具直接作答');
});

Deno.test('Max 还原：文本调用还原成 tool_use，输入被正确解析', () => {
  const restored = restoreToolUseFromText(
    '我先看看目录。\n[tool_use:Bash] id=call_abc123 input={"command":"ls -la","description":"list"}',
    req(),
  );

  assertEquals(restored.toolUseCount, 1, '还原条数');
  assertEquals(restored.unparsedCount, 0, '未解析条数');

  const toolUse = restored.content.find((b) => b.type === 'tool_use');
  assert(!!toolUse, '存在 tool_use 块');
  assertEquals(toolUse!.name, 'Bash', '工具名');
  assertEquals((toolUse!.input as { command?: string }).command, 'ls -la', 'command 参数');

  // 调用行之前的正文要保留，不能被吞掉
  const text = restored.content.find((b) => b.type === 'text');
  assert(!!text && text.text.includes('我先看看目录'), '保留调用行之前的正文');
});

Deno.test('Max 还原：带内层双引号的命令不被截断（schema 制导）', () => {
  const restored = restoreToolUseFromText(
    String
      .raw`[tool_use:Bash] id=call_q input={"command":"echo "hello world"; rm -rf /tmp/x","description":"say"}`,
    req(),
  );

  assertEquals(restored.unparsedCount, 0, '未解析条数');
  const toolUse = restored.content.find((b) => b.type === 'tool_use');
  const command = (toolUse?.input as { command?: string }).command ?? '';
  // 关键：命令不能被截断成 `rm -rf /`
  assert(command.includes('rm -rf /tmp/x'), `命令完整保留，实际：${command}`);
});

/**
 * 这是 Max 判定「Sider 没接住」的唯一判据。写成「没有 tool_use 就算失败」会
 * 把下一个用例里的正常回答也兜底掉。
 */
Deno.test('Max 还原：形状像调用却解析不出来 -> 计入 unparsed（触发 fallback）', () => {
  const restored = restoreToolUseFromText(
    '[tool_use:Bash] id=call_broken input={"command":',
    req(),
  );

  assertEquals(restored.toolUseCount, 0, '还原条数');
  assertEquals(restored.unparsedCount, 1, '未解析条数');
});

Deno.test('Max 还原：纯文本回答不算失败（契约允许不调用工具）', () => {
  const restored = restoreToolUseFromText(
    '这个目录下有 3 个文件，不需要执行命令我就能回答你。',
    req(),
  );

  assertEquals(restored.toolUseCount, 0, '还原条数');
  assertEquals(restored.unparsedCount, 0, '未解析条数 —— 正常回答不得被判失败');
});

Deno.test('Max 还原：模型复述历史调用 id 时不重复还原（避免二次执行写操作）', () => {
  const withHistory = req({
    messages: [
      { role: 'user', content: '清理构建产物' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_hist_1', name: 'Bash', input: {} }],
      } as unknown as AnthropicRequest['messages'][number],
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_hist_1', content: 'done' }],
      } as unknown as AnthropicRequest['messages'][number],
    ],
  });

  const restored = restoreToolUseFromText(
    '刚才我执行的是：\n[tool_use:Bash] id=call_hist_1 input={"command":"rm -rf build"}',
    withHistory,
  );

  assertEquals(restored.toolUseCount, 0, '不得还原历史调用');
  assertEquals(restored.replayedCount, 1, '复述计数');
});

/** 端到端：Max 下带工具的流式请求由 Sider 承接，客户端拿到结构化 tool_use。 */
Deno.test('Max 端到端：Sider 用文本契约完成工具回合，客户端收到 tool_use', async () => {
  const originalFetch = globalThis.fetch;
  const previous = new Map<string, string | undefined>();
  const env: Record<string, string | undefined> = {
    AUTH_TOKEN: 'test-token-12345',
    SIDER_AUTH_TOKEN: 'sider-token',
    DEEPSEEK_API_KEY: 'deepseek-token',
    DEEPSEEK_BASE_URL: 'https://api.deepseek.com/anthropic',
    DEFAULT_BACKEND: 'sider',
    SIDER_STRATEGY: 'max',
  };
  for (const [k, v] of Object.entries(env)) {
    previous.set(k, Deno.env.get(k));
    if (v === undefined) Deno.env.delete(k);
    else Deno.env.set(k, v);
  }

  let siderPrompt = '';
  let deepseekCalls = 0;

  try {
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('sider.ai')) {
        siderPrompt = String(init?.body ?? '');
        const line =
          '[tool_use:Bash] id=call_max_1 input={"command":"ls -la","description":"list dir"}';
        return Promise.resolve(
          new Response(
            `data: ${
              JSON.stringify({
                code: 0,
                msg: 'ok',
                data: { type: 'text', model: 'claude-sonnet-5', text: line },
              })
            }\n\n`,
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          ),
        );
      }
      deepseekCalls += 1;
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as typeof fetch;

    const routeModule = await import(
      `../src/routes/messages-hybrid.ts?test=${crypto.randomUUID()}`
    );
    const app = new Hono();
    app.route('/v1/messages', routeModule.hybridMessagesRouter);

    const response = await app.request('/v1/messages', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token-12345',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...req(), stream: true }),
    });

    assertEquals(response.status, 200, 'HTTP 状态');
    const body = await response.text();
    const events = body
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => JSON.parse(l.slice(5).trim()) as Record<string, unknown>);

    // 契约确实被注入进了发给 Sider 的载荷
    assert(siderPrompt.includes('[tool_use:ToolName]'), '契约注入 Sider 载荷');
    // 工具回合由 Sider 完成，没有落到 DeepSeek
    assertEquals(deepseekCalls, 0, 'DeepSeek 调用次数');

    const blockStart = events.find((e) =>
      e.type === 'content_block_start' &&
      (e.content_block as { type?: string })?.type === 'tool_use'
    );
    assert(!!blockStart, '客户端收到 tool_use 内容块');

    const delta = events.find((e) => e.type === 'message_delta');
    assertEquals(
      (delta?.delta as { stop_reason?: string })?.stop_reason,
      'tool_use',
      'stop_reason 必须改判，否则 Claude Code 判定回合结束',
    );
  } finally {
    globalThis.fetch = originalFetch;
    for (const [k, v] of previous) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
    resetSiderThrottle();
    resetSiderAvailability();
  }
});

/** 还原失败必须换后端重做，而不是把纯文本丢给 Claude Code 让 agent 循环停住。 */
Deno.test('Max 端到端：Sider 调用行残缺 -> fallback 到 DeepSeek', async () => {
  const originalFetch = globalThis.fetch;
  const previous = new Map<string, string | undefined>();
  const env: Record<string, string | undefined> = {
    AUTH_TOKEN: 'test-token-12345',
    SIDER_AUTH_TOKEN: 'sider-token',
    DEEPSEEK_API_KEY: 'deepseek-token',
    DEEPSEEK_BASE_URL: 'https://api.deepseek.com/anthropic',
    DEFAULT_BACKEND: 'sider',
    SIDER_STRATEGY: 'max',
  };
  for (const [k, v] of Object.entries(env)) {
    previous.set(k, Deno.env.get(k));
    if (v === undefined) Deno.env.delete(k);
    else Deno.env.set(k, v);
  }

  let deepseekCalls = 0;

  try {
    globalThis.fetch = ((input: string | URL | Request) => {
      if (String(input).includes('sider.ai')) {
        // 形状像调用，但 JSON 残缺，还原不出来
        const broken = '[tool_use:Bash] id=call_broken input={"command":';
        return Promise.resolve(
          new Response(
            `data: ${
              JSON.stringify({
                code: 0,
                msg: 'ok',
                data: { type: 'text', model: 'claude-sonnet-5', text: broken },
              })
            }\n\n`,
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          ),
        );
      }
      deepseekCalls += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: 'msg_ds',
            type: 'message',
            role: 'assistant',
            model: 'deepseek-v4-flash',
            content: [{
              type: 'tool_use',
              id: 'call_ds_1',
              name: 'Bash',
              input: { command: 'ls' },
            }],
            stop_reason: 'tool_use',
            usage: { input_tokens: 5, output_tokens: 6 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    }) as typeof fetch;

    const routeModule = await import(
      `../src/routes/messages-hybrid.ts?test=${crypto.randomUUID()}`
    );
    const app = new Hono();
    app.route('/v1/messages', routeModule.hybridMessagesRouter);

    const response = await app.request('/v1/messages', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token-12345',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...req(), stream: true }),
    });

    const body = await response.text();
    const events = body
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => JSON.parse(l.slice(5).trim()) as Record<string, unknown>);

    assertEquals(deepseekCalls, 1, 'DeepSeek 兜底调用次数');
    assertEquals(events.some((e) => e.type === 'error'), false, '客户端不应看到 error');

    const blockStart = events.find((e) =>
      e.type === 'content_block_start' &&
      (e.content_block as { type?: string })?.type === 'tool_use'
    );
    assert(!!blockStart, '兜底后仍拿到 tool_use 块');
  } finally {
    globalThis.fetch = originalFetch;
    for (const [k, v] of previous) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
    resetSiderThrottle();
    resetSiderAvailability();
  }
});

Deno.test('Max 路由：工具请求判给 Sider 且允许 fallback', async () => {
  resetSiderThrottle();
  resetSiderAvailability();
  try {
    const { RouterEngine } = await import('../src/routing/router-engine.ts');
    const base = {
      sider: { enabled: true, apiUrl: 'https://sider.ai/x', authToken: 't' },
      deepseek: {
        enabled: true,
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com/anthropic',
        apiKey: 'k',
        model: 'deepseek-v4-flash',
      },
      routing: {
        defaultBackend: 'sider',
        autoFallback: true,
        preferSiderForSimpleChat: true,
        debugMode: false,
        siderStrategy: 'max',
      },
    };

    const decision = new RouterEngine(base as never).decide(req());
    assertEquals(decision.backend, 'sider', 'Max 下工具请求的后端');
    assertEquals(decision.ruleId, 'rule_2_tools_sider_max', '规则');
    // 没有这条，Sider 接不住时就只能把纯文本丢给客户端
    assertEquals(decision.allowFallback, true, '必须允许 fallback');

    // Pro 档不接工具，仍旧全部交给 DeepSeek
    const pro = { ...base, routing: { ...base.routing, siderStrategy: 'pro' } };
    const proDecision = new RouterEngine(pro as never).decide(req());
    assertEquals(proDecision.backend, 'deepseek', 'Pro 下工具请求的后端');
  } finally {
    resetSiderThrottle();
    resetSiderAvailability();
  }
});
