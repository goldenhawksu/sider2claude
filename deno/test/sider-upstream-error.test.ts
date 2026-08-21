/**
 * Sider 在 SSE 内用 `code !== 0` 表达业务失败（HTTP 仍是 200）。
 * 这类失败过去被吞成一个没有内容块的空回复，既不 fallback 也无法诊断。
 * 本文件锁定修复后的行为，并顺带校验 SSE 事件带 `event:` 行。
 */

import { Hono } from 'hono';

function assertEquals<T>(actual: T, expected: T) {
  if (actual !== expected) {
    throw new Error(`断言失败：期望 ${String(expected)}，实际 ${String(actual)}`);
  }
}

function assertIncludes(haystack: string, needle: string) {
  if (!haystack.includes(needle)) {
    throw new Error(`断言失败：期望包含 ${needle}，实际 ${haystack}`);
  }
}

async function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void>,
) {
  const previous = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, Deno.env.get(key));
    if (value === undefined) {
      Deno.env.delete(key);
    } else {
      Deno.env.set(key, value);
    }
  }

  try {
    await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        Deno.env.delete(key);
      } else {
        Deno.env.set(key, value);
      }
    }
  }
}

/** Sider 用量超限：实测上游只回这一条事件就结束流。 */
const SIDER_LIMIT_SSE = `data: ${
  JSON.stringify({
    code: 1135,
    msg: "You've reached the current usage limit.",
    data: null,
  })
}\n\ndata: [DONE]\n\n`;

function siderResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });
}

function deepseekResponse(model: string): Response {
  return new Response(
    JSON.stringify({
      id: 'msg_deepseek_fallback',
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text: 'answered by deepseek' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

async function loadRoute() {
  const routeModule = await import(
    `../src/routes/messages-hybrid.ts?test=${crypto.randomUUID()}`
  );
  const app = new Hono();
  app.route('/v1/messages', routeModule.hybridMessagesRouter);
  return app;
}

function chatRequest(extra: Record<string, unknown> = {}) {
  return {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-token-12345',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4.5',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 16,
      ...extra,
    }),
  };
}

Deno.test('Sider 用量超限且禁用 fallback：返回 429 错误而非空回复', async () => {
  const originalFetch = globalThis.fetch;

  try {
    await withEnv({
      AUTH_TOKEN: 'test-token-12345',
      SIDER_AUTH_TOKEN: 'sider-token',
      DEFAULT_BACKEND: 'sider',
      PREFER_SIDER_FOR_CHAT: 'true',
      AUTO_FALLBACK: 'false',
    }, async () => {
      globalThis.fetch = (() =>
        Promise.resolve(siderResponse(SIDER_LIMIT_SSE))) as typeof fetch;

      const app = await loadRoute();
      const response = await app.request('/v1/messages', chatRequest());

      assertEquals(response.status, 429);
      const body = await response.json() as {
        type: string;
        error: { type: string; message: string };
      };
      assertEquals(body.type, 'error');
      assertEquals(body.error.type, 'rate_limit_error');
      assertIncludes(body.error.message, '1135');
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('Sider 用量超限且允许 fallback：非流式转由 DeepSeek 作答', async () => {
  const originalFetch = globalThis.fetch;
  const hits: string[] = [];

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
    }, async () => {
      globalThis.fetch = ((input: string | URL | Request) => {
        const url = input.toString();
        hits.push(url);
        if (url.includes('deepseek.com')) {
          return Promise.resolve(deepseekResponse('claude-haiku-4.5'));
        }
        return Promise.resolve(siderResponse(SIDER_LIMIT_SSE));
      }) as typeof fetch;

      const app = await loadRoute();
      const response = await app.request('/v1/messages', chatRequest());

      assertEquals(response.status, 200);
      const body = await response.json() as {
        model: string;
        content: Array<{ type: string; text?: string }>;
      };
      // 对外仍保留客户端请求的 Claude 模型名。
      assertEquals(body.model, 'claude-haiku-4.5');
      assertEquals(body.content[0].text, 'answered by deepseek');
      assertEquals(hits.some((url) => url.includes('deepseek.com')), true);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('Sider 已作答时附带的非致命警告不应判定为失败', async () => {
  const originalFetch = globalThis.fetch;

  try {
    await withEnv({
      AUTH_TOKEN: 'test-token-12345',
      SIDER_AUTH_TOKEN: 'sider-token',
      DEFAULT_BACKEND: 'sider',
      PREFER_SIDER_FOR_CHAT: 'true',
      AUTO_FALLBACK: 'false',
    }, async () => {
      const body = `data: ${
        JSON.stringify({
          code: 0,
          msg: 'ok',
          data: { type: 'text', model: 'claude-haiku-4.5', text: '北京' },
        })
      }\n\ndata: ${
        JSON.stringify({ code: 1099, msg: 'non-fatal notice', data: null })
      }\n\ndata: [DONE]\n\n`;

      globalThis.fetch = (() => Promise.resolve(siderResponse(body))) as typeof fetch;

      const app = await loadRoute();
      const response = await app.request('/v1/messages', chatRequest());

      assertEquals(response.status, 200);
      const json = await response.json() as { content: Array<{ text?: string }> };
      assertEquals(json.content[0].text, '北京');
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('Sider 用量超限：流式在流内发 error 事件，且 SSE 带 event: 行', async () => {
  const originalFetch = globalThis.fetch;

  try {
    await withEnv({
      AUTH_TOKEN: 'test-token-12345',
      SIDER_AUTH_TOKEN: 'sider-token',
      DEFAULT_BACKEND: 'sider',
      PREFER_SIDER_FOR_CHAT: 'true',
      AUTO_FALLBACK: 'true',
    }, async () => {
      globalThis.fetch = (() =>
        Promise.resolve(siderResponse(SIDER_LIMIT_SSE))) as typeof fetch;

      const app = await loadRoute();
      const response = await app.request('/v1/messages', chatRequest({ stream: true }));

      assertEquals(response.status, 200);
      const raw = await response.text();

      // 每条 data: 行前必须有配对的 event: 行。
      const eventNames = [...raw.matchAll(/^event: (\S+)$/gm)].map((m) => m[1]);
      const dataLines = raw.split(/\r?\n/).filter((line) => line.startsWith('data:'));
      assertEquals(eventNames.length, dataLines.length);
      assertEquals(eventNames[0], 'message_start');
      assertEquals(eventNames.includes('error'), true);

      const errorLine = dataLines
        .map((line) => JSON.parse(line.slice(5).trim()) as Record<string, unknown>)
        .find((event) => event.type === 'error');
      const errorPayload = errorLine?.error as { type: string; message: string };
      assertEquals(errorPayload.type, 'rate_limit_error');
      assertIncludes(errorPayload.message, '1135');
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('正常流式回复：SSE 事件带 event: 行且内容块完整', async () => {
  const originalFetch = globalThis.fetch;

  try {
    await withEnv({
      AUTH_TOKEN: 'test-token-12345',
      SIDER_AUTH_TOKEN: 'sider-token',
      DEFAULT_BACKEND: 'sider',
      PREFER_SIDER_FOR_CHAT: 'true',
      AUTO_FALLBACK: 'true',
    }, async () => {
      const body = `data: ${
        JSON.stringify({
          code: 0,
          msg: 'ok',
          data: { type: 'text', model: 'claude-haiku-4.5', text: 'OK' },
        })
      }\n\ndata: [DONE]\n\n`;

      globalThis.fetch = (() => Promise.resolve(siderResponse(body))) as typeof fetch;

      const app = await loadRoute();
      const response = await app.request('/v1/messages', chatRequest({ stream: true }));

      const raw = await response.text();
      const eventNames = [...raw.matchAll(/^event: (\S+)$/gm)].map((m) => m[1]);

      for (
        const expected of [
          'message_start',
          'content_block_start',
          'content_block_delta',
          'content_block_stop',
          'message_delta',
          'message_stop',
        ]
      ) {
        assertEquals(eventNames.includes(expected), true);
      }
      assertEquals(eventNames.includes('error'), false);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
