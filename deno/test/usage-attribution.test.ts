/**
 * DeepSeek 归因的端到端确定性测试（mock 上游，打真实路由）。
 *
 * 单测能证明 `classifyDeepSeekReason` 的分类逻辑对，但证明不了路由真的把
 * 对应的 ruleId 传进了埋点。这里从 HTTP 请求进、看统计快照出，锁定用户
 * 真正关心的口径：Claude Code 跑一轮之后，某个模型有多少次走了 DeepSeek，
 * 其中多少是"带工具本就该走"、多少是"Sider 受限被迫兜底"。
 */

import { Hono } from 'hono';
import { getUsageSnapshot, resetUsageStats } from '../src/utils/usage-stats.ts';

function assertEquals<T>(actual: T, expected: T, what = '值') {
  if (actual !== expected) {
    throw new Error(`${what}：期望 ${String(expected)}，实际 ${String(actual)}`);
  }
}

async function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void>,
) {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, Deno.env.get(key));
    if (value === undefined) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

async function loadRoute() {
  const routeModule = await import(
    `../src/routes/messages-hybrid.ts?test=${crypto.randomUUID()}`
  );
  const app = new Hono();
  app.route('/v1/messages', routeModule.hybridMessagesRouter);
  return app;
}

function post(body: Record<string, unknown>) {
  return {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-token-12345',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  };
}

/** Sider 用量超限：HTTP 200 + SSE 内 code 1135。 */
const SIDER_LIMIT_SSE = `data: ${
  JSON.stringify({ code: 1135, msg: 'usage limit', data: null })
}\n\ndata: [DONE]\n\n`;

function siderText(text: string): Response {
  return new Response(
    `data: ${
      JSON.stringify({
        code: 0,
        msg: 'ok',
        data: { type: 'text', model: 'claude-haiku-4.5', text },
      })
    }\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
  );
}

function deepseekJson(model: string, content: unknown[]): Response {
  return new Response(
    JSON.stringify({
      id: 'msg_attr',
      type: 'message',
      role: 'assistant',
      model,
      content,
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

const BASH_TOOL = {
  name: 'Bash',
  description: 'Run a shell command',
  input_schema: {
    type: 'object',
    properties: { command: { type: 'string' } },
    required: ['command'],
  },
};

Deno.test({
  name: '归因端到端：带 Claude Code 工具的请求记为 tools，不是 fallback',
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const originalFetch = globalThis.fetch;
  try {
    await withEnv({
      AUTH_TOKEN: 'test-token-12345',
      SIDER_AUTH_TOKEN: 'sider-token',
      DEEPSEEK_API_KEY: 'deepseek-token',
      DEEPSEEK_BASE_URL: 'https://api.deepseek.com/anthropic',
      DEEPSEEK_MODEL: 'deepseek-v4-flash',
      DEFAULT_BACKEND: 'sider',
      PREFER_SIDER_FOR_CHAT: 'true',
      AUTO_FALLBACK: 'true',
      STATS_KV: undefined, // 只验进程内聚合，KV 由 usage-stats-kv.test.ts 覆盖
    }, async () => {
      resetUsageStats();
      globalThis.fetch = (() =>
        Promise.resolve(
          deepseekJson('claude-sonnet-4.6', [{ type: 'text', text: 'done' }]),
        )) as typeof fetch;

      const app = await loadRoute();
      const response = await app.request(
        '/v1/messages',
        post({
          model: 'claude-sonnet-4.6',
          messages: [{ role: 'user', content: 'run ls' }],
          max_tokens: 64,
          tools: [BASH_TOOL],
        }),
      );
      assertEquals(response.status, 200);

      const snap = getUsageSnapshot();
      const model = snap.models.find((m) => m.model === 'claude-sonnet-4.6')!;
      assertEquals(model.deepseek, 1, '走 deepseek 次数');
      assertEquals(model.deepseekTools, 1, '工具归因');
      assertEquals(model.deepseekFallback, 0, '不应记成受限兜底');
      assertEquals(model.deepseekRouting, 0, '不应记成策略');
      // Sider 从头到尾没被调用，fallback 计数必须为 0
      assertEquals(snap.totals.fallbacks, 0, 'fallback 总数');
      assertEquals(snap.recent[0].reason, 'tools', '明细归因');
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test({
  name: '归因端到端：Sider 用量超限后兜底记为 fallback',
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const originalFetch = globalThis.fetch;
  try {
    await withEnv({
      AUTH_TOKEN: 'test-token-12345',
      SIDER_AUTH_TOKEN: 'sider-token',
      DEEPSEEK_API_KEY: 'deepseek-token',
      DEEPSEEK_BASE_URL: 'https://api.deepseek.com/anthropic',
      DEEPSEEK_MODEL: 'deepseek-v4-flash',
      DEFAULT_BACKEND: 'sider',
      PREFER_SIDER_FOR_CHAT: 'true',
      AUTO_FALLBACK: 'true',
      STATS_KV: undefined,
    }, async () => {
      resetUsageStats();
      globalThis.fetch = ((input: string | URL | Request) => {
        const url = input.toString();
        if (url.includes('deepseek.com')) {
          return Promise.resolve(
            deepseekJson('claude-haiku-4.5', [{ type: 'text', text: 'from deepseek' }]),
          );
        }
        return Promise.resolve(
          new Response(SIDER_LIMIT_SSE, {
            status: 200,
            headers: { 'content-type': 'text/event-stream; charset=utf-8' },
          }),
        );
      }) as typeof fetch;

      const app = await loadRoute();
      const response = await app.request(
        '/v1/messages',
        post({
          model: 'claude-haiku-4.5',
          messages: [{ role: 'user', content: '你好' }],
          max_tokens: 64,
        }),
      );
      assertEquals(response.status, 200);

      const snap = getUsageSnapshot();
      const model = snap.models.find((m) => m.model === 'claude-haiku-4.5')!;
      assertEquals(model.deepseek, 1, '走 deepseek 次数');
      assertEquals(model.deepseekFallback, 1, '受限兜底归因');
      assertEquals(model.deepseekTools, 0, '不应记成工具');
      assertEquals(snap.totals.fallbacks, 1, 'fallback 总数');
      assertEquals(snap.recent[0].reason, 'fallback', '明细归因');
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test({
  name: '归因端到端：Sider 正常作答时不产生任何 DeepSeek 归因',
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const originalFetch = globalThis.fetch;
  try {
    await withEnv({
      AUTH_TOKEN: 'test-token-12345',
      SIDER_AUTH_TOKEN: 'sider-token',
      DEEPSEEK_API_KEY: 'deepseek-token',
      DEEPSEEK_BASE_URL: 'https://api.deepseek.com/anthropic',
      DEFAULT_BACKEND: 'sider',
      PREFER_SIDER_FOR_CHAT: 'true',
      AUTO_FALLBACK: 'true',
      STATS_KV: undefined,
    }, async () => {
      resetUsageStats();
      globalThis.fetch = (() => Promise.resolve(siderText('北京'))) as typeof fetch;

      const app = await loadRoute();
      const response = await app.request(
        '/v1/messages',
        post({
          model: 'claude-haiku-4.5',
          messages: [{ role: 'user', content: '中国的首都' }],
          max_tokens: 64,
        }),
      );
      assertEquals(response.status, 200);

      const snap = getUsageSnapshot();
      const model = snap.models.find((m) => m.model === 'claude-haiku-4.5')!;
      assertEquals(model.sider, 1, '走 sider 次数');
      assertEquals(model.deepseek, 0, 'deepseek 次数');
      assertEquals(model.deepseekTools + model.deepseekFallback + model.deepseekRouting, 0, '归因');
      assertEquals(snap.recent[0].reason, null, '明细归因');
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/**
 * DeepSeek 无工具真流式过去完全没有埋点，这类请求在统计里凭空消失，
 * 后端占比会系统性偏向 Sider。归因功能建立在计数正确之上，故一并锁定。
 */
Deno.test({
  name: '归因端到端：DeepSeek 无工具流式被计入，并按 routing 归因',
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const originalFetch = globalThis.fetch;
  try {
    await withEnv({
      AUTH_TOKEN: 'test-token-12345',
      SIDER_AUTH_TOKEN: undefined, // 关掉 Sider，让简单对话落到 DeepSeek
      DEEPSEEK_API_KEY: 'deepseek-token',
      DEEPSEEK_BASE_URL: 'https://api.deepseek.com/anthropic',
      DEEPSEEK_MODEL: 'deepseek-v4-flash',
      DEFAULT_BACKEND: 'deepseek',
      PREFER_SIDER_FOR_CHAT: 'false',
      STATS_KV: undefined,
    }, async () => {
      resetUsageStats();
      const sse = [
        `data: ${
          JSON.stringify({
            type: 'message_start',
            message: {
              id: 'msg_1',
              type: 'message',
              role: 'assistant',
              content: [],
              model: 'deepseek-v4-flash',
              usage: { input_tokens: 11, output_tokens: 0 },
            },
          })
        }`,
        `data: ${
          JSON.stringify({
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 7 },
          })
        }`,
        'data: [DONE]',
      ].join('\n\n') + '\n\n';

      globalThis.fetch = (() =>
        Promise.resolve(
          new Response(sse, {
            status: 200,
            headers: { 'content-type': 'text/event-stream; charset=utf-8' },
          }),
        )) as typeof fetch;

      const app = await loadRoute();
      const response = await app.request(
        '/v1/messages',
        post({
          model: 'claude-opus-4.6',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 32,
          stream: true,
        }),
      );
      assertEquals(response.status, 200);
      await response.text(); // 埋点在流读完时触发

      const snap = getUsageSnapshot();
      assertEquals(snap.totals.requests, 1, '流式请求必须被计入');
      assertEquals(snap.totals.streaming, 1, '流式计数');
      const model = snap.models.find((m) => m.model === 'claude-opus-4.6')!;
      assertEquals(model.deepseek, 1, '走 deepseek 次数');
      assertEquals(model.deepseekRouting, 1, '策略归因');
      assertEquals(model.deepseekFallback, 0, '流式不做 fallback');
      // token 从 SSE 事件里捡回来，否则流式请求的用量永远是 0
      assertEquals(model.inputTokens, 11, '输入 token');
      assertEquals(model.outputTokens, 7, '输出 token');
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
