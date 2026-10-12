import { Hono } from 'hono';
import { AnthropicApiAdapter } from '../src/adapters/anthropic-adapter.ts';
import { RouterEngine } from '../src/routing/router-engine.ts';
import type { BackendConfig } from '../src/config/backends.ts';
import type { AnthropicRequest } from '../src/types/anthropic.ts';
import { getSiderThrottleSnapshot, resetSiderThrottle } from '../src/utils/sider-throttle.ts';

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `期望${JSON.stringify(expected)?.slice(0, 200)}，实际${
        JSON.stringify(actual)?.slice(0, 200)
      }`,
    );
  }
}
const system =
  'Command safety classifier. Classification output: <block>yes</block> or <block>no</block>.';
const config: BackendConfig = {
  sider: { enabled: true, apiUrl: 'https://sider.ai/api/chat/v1/completions', authToken: 'test' },
  deepseek: {
    enabled: true,
    provider: 'anthropic-compatible',
    baseUrl: 'https://classifier.example',
    apiKey: 'test',
    model: 'glm-5.3-flash',
  },
  routing: {
    defaultBackend: 'sider',
    autoFallback: true,
    preferSiderForSimpleChat: true,
    debugMode: false,
    siderStrategy: 'max',
  },
};
const request: AnthropicRequest = {
  model: 'claude-sonnet-5.5[1M]',
  system,
  max_tokens: 64,
  thinking: { type: 'disabled' },
  stop_sequences: ['</block>'],
  messages: [{ role: 'user', content: 'Analyze Get-ChildItem C:/isolated' }],
};

Deno.test('安全分类路由：原生XML协议优先兼容后端，无Sider回退且不消耗其额度', () => {
  try {
    resetSiderThrottle();
    const router = new RouterEngine(config);
    router.recordSessionBackend('classifier-session', 'sider');
    const decision = router.decide(request, 'classifier-session');
    equal(decision.backend, 'deepseek');
    equal(decision.allowFallback, false);
    equal(decision.ruleId, 'rule_0_safety_classifier');
    equal(getSiderThrottleSnapshot().length, 0);
    // 正文里提到分类标签、只有模型后缀、或声明了工具，都不能触发分类专用路由。
    for (
      const normal of [{ ...request, system: undefined }, {
        ...request,
        system: 'Explain the literal <block> tag.',
      }, {
        ...request,
        tools: [{ name: 'Read', input_schema: { type: 'object' as const, properties: {} } }],
      }]
    ) {
      equal(router.decide(normal).backend, 'sider');
    }
  } finally {
    resetSiderThrottle();
  }
});

Deno.test('64-token分类：调用方明确关闭thinking时首次即兑现', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = ((_url, init) => {
      const body = JSON.parse(String(init?.body));
      equal(body.thinking, { type: 'disabled' });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: 'classifier-disabled',
            type: 'message',
            role: 'assistant',
            model: body.model,
            content: [{ type: 'text', text: '<block>no</block>' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 8 },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      );
    }) as typeof fetch;
    const response = await new AnthropicApiAdapter(config.deepseek).sendRequest(request);
    equal(response.content[0], { type: 'text', text: '<block>no' });
    equal(response.stop_reason, 'stop_sequence');
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test('主控启用时分类旁路：完整system、XML判定、停止序列及HTTP错误原样保留', async () => {
  const original = globalThis.fetch;
  const vars = {
    AUTH_TOKEN: 'classifier-owner',
    SIDER_AUTH_TOKEN: 'sider-token',
    SIDER_CONTROLLER: 'true',
    SIDER_CONTROLLER_STREAMING: 'true',
    SIDER_CONTROLLER_STORAGE: 'memory',
    DEEPSEEK_BASE_URL: 'https://classifier.example',
    DEEPSEEK_API_KEY: 'classifier-key',
    DEEPSEEK_MODEL: 'glm-5.3-flash',
  };
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, Deno.env.get(key));
    Deno.env.set(key, value);
  }
  let fail = false, calls = 0;
  const largeSystem = (system + '\n' + 'Only analyze the transcript.\n'.repeat(5000)).trim();
  try {
    globalThis.fetch = ((_url, init) => {
      calls++;
      equal(String(_url), 'https://classifier.example/v1/messages');
      const body = JSON.parse(String(init?.body));
      equal(body.model, 'glm-5.3-flash');
      equal(body.system, largeSystem);
      equal(body.tools, undefined);
      equal(body.thinking, { type: 'disabled' });
      if (fail) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              type: 'error',
              error: { type: 'rate_limit_error', message: '限流测试' },
            }),
            { status: 429 },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          [
            {
              type: 'message_start',
              message: {
                id: 'classifier-http',
                type: 'message',
                role: 'assistant',
                model: body.model,
                content: [],
                usage: { input_tokens: 1000, output_tokens: 0 },
              },
            },
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: '<block>yes</block><reason>需人工确认</reason>' },
            },
            { type: 'content_block_stop', index: 0 },
            {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn' },
              usage: { output_tokens: 20 },
            },
            { type: 'message_stop' },
          ].map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      );
    }) as typeof fetch;
    const routes = await import(
      `../src/routes/messages-hybrid.ts?classifier=${crypto.randomUUID()}`
    );
    const app = new Hono();
    app.route('/v1/messages', routes.hybridMessagesRouter);
    const send = (stream: boolean) =>
      app.request('/v1/messages?beta=true', {
        method: 'POST',
        headers: {
          'x-api-key': 'classifier-owner',
          'content-type': 'application/json',
          'anthropic-beta': 'context-1m-2025-08-07',
        },
        body: JSON.stringify({
          ...request,
          system: largeSystem,
          stream,
          messages: [{ role: 'user', content: crypto.randomUUID() }],
        }),
      });
    const first = await send(false);
    equal(first.status, 200);
    const json = await first.json();
    equal(json.model, request.model);
    equal(json.content[0].text, '<block>yes');
    equal(json.stop_reason, 'stop_sequence');
    equal(json.stop_sequence, '</block>');
    const stream = await send(true);
    const text = await stream.text();
    equal(text.includes('event: message_stop'), true);
    equal(text.includes('<block>yes'), true);
    fail = true;
    const failed = await send(false);
    equal(failed.status, 429);
    equal((await failed.json()).error.type, 'rate_limit_error');
    equal(calls, 3);
  } finally {
    globalThis.fetch = original;
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
});
