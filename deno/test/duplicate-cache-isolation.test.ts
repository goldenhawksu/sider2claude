/**
 * 重复响应缓存与流式请求隔离。
 *
 * 指纹（hashAnthropicRequest）刻意忽略 stream 字段，用于跨流式/非流式
 * 识别客户端重试（观测语义）。但重复响应缓存曾直接复用该指纹作为键，
 * 导致：流式请求完成的响应会被后续的"等价非流式请求"回放——语义错配，
 * 客户端要 SSE 却拿到缓存快照，且流式路径写入的失败残骸同样会被回放。
 *
 * 本文件锁定修复后的行为：缓存键带流式标记，且只有非流式路径写缓存。
 */

import { Hono } from 'hono';

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

function deepseekResponse(model: string, text: string): Response {
  return new Response(
    JSON.stringify({
      id: `msg_${text}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text }],
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

function chatBody(model: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    model,
    max_tokens: 32,
    messages: [{ role: 'user', content: '同一句话' }],
    ...extra,
  });
}

const HEADERS = {
  authorization: 'Bearer test-token-12345',
  'content-type': 'application/json',
};

Deno.test('流式完成的响应不会被等价非流式请求回放', async () => {
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;

  try {
    await withEnv({
      AUTH_TOKEN: 'test-token-12345',
      DEEPSEEK_API_KEY: 'deepseek-token',
      DEEPSEEK_BASE_URL: 'https://api.deepseek.com/anthropic',
      DEEPSEEK_MODEL: 'deepseek-v4-flash',
      DEFAULT_BACKEND: 'deepseek',
      PREFER_SIDER_FOR_CHAT: 'false',
      SIDER_AUTH_TOKEN: undefined,
    }, async () => {
      globalThis.fetch = (() => {
        upstreamCalls += 1;
        return Promise.resolve(deepseekResponse('claude-opus-4.6', `第${upstreamCalls}次响应`));
      }) as typeof fetch;

      const app = await loadRoute();

      // 1) 流式请求（走合成流式路径，不再写缓存）
      const streamed = await app.request('/v1/messages', {
        method: 'POST',
        headers: HEADERS,
        body: chatBody('claude-opus-4.6', { stream: true }),
      });
      assertEquals(streamed.status, 200);
      await streamed.text();

      // 2) 同内容非流式请求：指纹忽略 stream、理应同哈希，但不得回放流式的响应
      const nonStream = await app.request('/v1/messages', {
        method: 'POST',
        headers: HEADERS,
        body: chatBody('claude-opus-4.6'),
      });
      assertEquals(nonStream.status, 200);
      assertEquals(nonStream.headers.get('X-Duplicate-Replay'), null, '不应命中回放');
      const first = await nonStream.json() as { content: Array<{ text: string }> };
      assertEquals(first.content[0].text, '第2次响应', '应当是新的上游响应');

      // 3) 非流式完成后，相同的非流式请求才允许幂等回放
      const replay = await app.request('/v1/messages', {
        method: 'POST',
        headers: HEADERS,
        body: chatBody('claude-opus-4.6'),
      });
      assertEquals(replay.headers.get('X-Duplicate-Replay'), 'true', '非流式重复请求回放');
      const second = await replay.json() as { content: Array<{ text: string }> };
      assertEquals(second.content[0].text, '第2次响应', '回放内容与非流式原响应一致');
      assertEquals(upstreamCalls, 2, '上游只被调用两次');
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
