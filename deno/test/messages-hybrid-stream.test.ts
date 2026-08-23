import { Hono } from 'hono';
import type { AnthropicRequest } from '../src/types/anthropic.ts';

function assertEquals<T>(actual: T, expected: T) {
  if (actual !== expected) {
    throw new Error(`assert failed: expected ${String(expected)}, actual ${String(actual)}`);
  }
}

function assertExists(value: unknown) {
  if (value === undefined || value === null) {
    throw new Error('assert failed: expected value to exist');
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

function parseSseEvents(text: string): Array<Record<string, unknown>> {
  return text
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice(5).trim()) as Record<string, unknown>);
}

function parseFirstSseEvent(value: Uint8Array): Record<string, unknown> {
  const text = new TextDecoder().decode(value);
  const line = text.split(/\r?\n/).find((line) => line.startsWith('data:'));
  if (!line) {
    throw new Error(`assert failed: expected SSE data line in ${text}`);
  }
  return JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ms: number,
): Promise<ReadableStreamReadResult<Uint8Array> | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), ms);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

Deno.test('sider stream sends message_start before upstream response', async () => {
  const originalFetch = globalThis.fetch;
  const upstream = deferred<Response>();

  try {
    await withEnv({
      AUTH_TOKEN: 'test-token-12345',
      SIDER_AUTH_TOKEN: 'sider-token',
      DEFAULT_BACKEND: 'sider',
      PREFER_SIDER_FOR_CHAT: 'true',
      DEEPSEEK_API_KEY: undefined,
    }, async () => {
      globalThis.fetch = (() => upstream.promise) as typeof fetch;

      const routeModule = await import(
        `../src/routes/messages-hybrid.ts?test=${crypto.randomUUID()}`
      );
      const app = new Hono();
      app.route('/v1/messages', routeModule.hybridMessagesRouter);

      const response = await app.request('/v1/messages?beta=true', {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token-12345',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4.5',
          messages: [{ role: 'user', content: 'hello' }],
          max_tokens: 16,
          stream: true,
        }),
      });

      assertEquals(response.status, 200);
      assertExists(response.body);

      const reader = response.body!.getReader();
      const first = await readWithTimeout(reader, 100);
      if (first === 'timeout') {
        upstream.reject(new Error('test cleanup'));
        throw new Error('assert failed: expected first SSE event before upstream response');
      }

      const firstEvent = parseFirstSseEvent(first.value!);
      assertEquals(firstEvent.type, 'message_start');

      upstream.resolve(
        new Response(
          `data: ${
            JSON.stringify({
              code: 0,
              msg: 'ok',
              data: { type: 'text', model: 'claude-haiku-4.5', text: 'OK' },
            })
          }\n\ndata: [DONE]\n\n`,
          {
            status: 200,
            headers: { 'content-type': 'text/event-stream; charset=utf-8' },
          },
        ),
      );

      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('hybrid route synthesizes tool stream and replays duplicate non-stream request', async () => {
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
      globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
        upstreamCalls += 1;
        const body = JSON.parse(init?.body as string) as AnthropicRequest;

        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 'msg_textual_tool_stream',
              type: 'message',
              role: 'assistant',
              model: body.model,
              content: [{
                type: 'text',
                text:
                  'I need to inspect the file.\n[tool_use:Read] id=call_read_1 input={"file_path":"deno_pro.ts","limit":200}',
              }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 10, output_tokens: 8 },
            }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          ),
        );
      }) as typeof fetch;

      const routeModule = await import(
        `../src/routes/messages-hybrid.ts?test=${crypto.randomUUID()}`
      );
      const app = new Hono();
      app.route('/v1/messages', routeModule.hybridMessagesRouter);

      const request: AnthropicRequest = {
        model: 'claude-opus-4.6',
        messages: [{ role: 'user', content: 'review deno_pro.ts' }],
        max_tokens: 128,
        stream: true,
        tools: [{
          name: 'Read',
          description: 'Read file',
          input_schema: {
            type: 'object',
            properties: {
              file_path: { type: 'string' },
              limit: { type: 'number' },
            },
            required: ['file_path'],
          },
        }],
      };

      const streamResponse = await app.request('/v1/messages?beta=true', {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token-12345',
          'content-type': 'application/json',
        },
        body: JSON.stringify(request),
      });
      assertEquals(streamResponse.status, 200);

      const events = parseSseEvents(await streamResponse.text());
      assertEquals(events[0].type, 'message_start');
      assertExists(events.find((event) =>
        event.type === 'content_block_start' &&
        (event.content_block as { type?: string; name?: string })?.type === 'tool_use' &&
        (event.content_block as { type?: string; name?: string })?.name === 'Read'
      ));
      assertExists(events.find((event) =>
        event.type === 'message_delta' &&
        (event.delta as { stop_reason?: string })?.stop_reason === 'tool_use'
      ));
      assertEquals(events[events.length - 1].type, 'message_stop');

      const replayResponse = await app.request('/v1/messages?beta=true', {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token-12345',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ ...request, stream: false }),
      });
      assertEquals(replayResponse.status, 200);
      // 指纹忽略 stream（跨流式/非流式识别客户端重试），但响应缓存按流式隔离：
      // 流式完成的响应不得被等价非流式请求回放，须重新请求上游。
      assertEquals(replayResponse.headers.get('X-Duplicate-Replay'), null);
      assertEquals(upstreamCalls, 2);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('hybrid route maps missing user message validation to 400', async () => {
  await withEnv({
    AUTH_TOKEN: 'test-token-12345',
    DEEPSEEK_API_KEY: 'deepseek-token',
    DEEPSEEK_BASE_URL: 'https://api.deepseek.com/anthropic',
    DEFAULT_BACKEND: 'deepseek',
    SIDER_AUTH_TOKEN: undefined,
  }, async () => {
    const routeModule = await import(
      `../src/routes/messages-hybrid.ts?test=${crypto.randomUUID()}`
    );
    const app = new Hono();
    app.route('/v1/messages', routeModule.hybridMessagesRouter);

    const response = await app.request('/v1/messages?beta=true', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token-12345',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4.6',
        messages: [{ role: 'assistant', content: 'assistant only' }],
        max_tokens: 16,
      }),
    });

    assertEquals(response.status, 400);
    const body = await response.json() as { error?: { type?: string; message?: string } };
    assertEquals(body.error?.type, 'invalid_request_error');
    assertEquals(body.error?.message, 'At least one user message is required');
  });
});

/**
 * 流式无感 fallback。
 *
 * 激进投递策略主动碰撞 Sider 的额度上限，失败会变多。而流式路径此前完全没有
 * 后端兜底——Sider 一失败就把 Anthropic `error` 事件甩给客户端。没有这层兜底，
 * 「优先投 Sider」等于「让用户天天看到失败」。
 *
 * 切换窗口的判据是「一个内容块都还没开过」：那时客户端只收到过 message_start，
 * 而该事件不带任何后端烙印（id 本地生成、model 是客户端请求的模型名），
 * 因此改由 DeepSeek 续吐在协议上不可区分。已经吐过内容就没有回退空间了。
 */
Deno.test('sider stream: 首个内容块之前失败 -> 静默改由 DeepSeek 承接', async () => {
  const originalFetch = globalThis.fetch;
  const { resetSiderAvailability } = await import('../src/utils/sider-availability.ts');
  let deepseekCalls = 0;

  try {
    await withEnv({
      AUTH_TOKEN: 'test-token-12345',
      SIDER_AUTH_TOKEN: 'sider-token',
      DEEPSEEK_API_KEY: 'deepseek-token',
      DEEPSEEK_BASE_URL: 'https://api.deepseek.com/anthropic',
      DEFAULT_BACKEND: 'sider',
      PREFER_SIDER_FOR_CHAT: 'true',
    }, async () => {
      globalThis.fetch = ((input: string | URL | Request) => {
        if (String(input).includes('sider.ai')) {
          // Sider 在吐出任何文本之前就报用量超限（HTTP 200 + SSE 内 code != 0）
          return Promise.resolve(
            new Response(
              `data: ${JSON.stringify({ code: 1135, msg: 'Usage limit reached' })}\n\n`,
              { status: 200, headers: { 'content-type': 'text/event-stream' } },
            ),
          );
        }

        deepseekCalls += 1;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 'msg_fallback',
              type: 'message',
              role: 'assistant',
              model: 'deepseek-v4-flash',
              content: [{ type: 'text', text: '由 DeepSeek 兜底的回答' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 7, output_tokens: 11 },
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

      const response = await app.request('/v1/messages?beta=true', {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token-12345',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4.5',
          messages: [{ role: 'user', content: 'hello' }],
          max_tokens: 16,
          stream: true,
        }),
      });

      assertEquals(response.status, 200);
      const events = parseSseEvents(await response.text());
      const types = events.map((event) => event.type);

      assertEquals(deepseekCalls, 1);
      assertEquals(types.includes('error'), false);
      assertEquals(types.filter((type) => type === 'message_start').length, 1);
      assertEquals(types.at(-1), 'message_stop');

      const delta = events.find((event) => event.type === 'content_block_delta');
      assertExists(delta);
      assertEquals(
        (delta!.delta as { text?: string }).text,
        '由 DeepSeek 兜底的回答',
      );
    });
  } finally {
    globalThis.fetch = originalFetch;
    // 1135 会写模块级熔断状态，不复位会顺着文件执行顺序泄漏给后续测试
    resetSiderAvailability();
  }
});

Deno.test('sider stream: 已经吐过内容后失败 -> 仍然报错，不做半路切换', async () => {
  const originalFetch = globalThis.fetch;
  const { resetSiderAvailability } = await import('../src/utils/sider-availability.ts');
  let deepseekCalls = 0;

  try {
    await withEnv({
      AUTH_TOKEN: 'test-token-12345',
      SIDER_AUTH_TOKEN: 'sider-token',
      DEEPSEEK_API_KEY: 'deepseek-token',
      DEEPSEEK_BASE_URL: 'https://api.deepseek.com/anthropic',
      DEFAULT_BACKEND: 'sider',
      PREFER_SIDER_FOR_CHAT: 'true',
    }, async () => {
      globalThis.fetch = ((input: string | URL | Request) => {
        if (String(input).includes('sider.ai')) {
          // 先吐一段文本，再报错：此时切后端会让文本断裂或重复
          const text = `data: ${
            JSON.stringify({
              code: 0,
              msg: 'ok',
              data: { type: 'text', model: 'claude-haiku-4.5', text: '已经开始回答' },
            })
          }\n\ndata: ${JSON.stringify({ code: 1135, msg: 'Usage limit reached' })}\n\n`;
          return Promise.resolve(
            new Response(text, {
              status: 200,
              headers: { 'content-type': 'text/event-stream' },
            }),
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

      const response = await app.request('/v1/messages?beta=true', {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token-12345',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4.5',
          messages: [{ role: 'user', content: 'hello' }],
          max_tokens: 16,
          stream: true,
        }),
      });

      const events = parseSseEvents(await response.text());
      const error = events.find((event) => event.type === 'error');

      assertEquals(deepseekCalls, 0);
      assertExists(error);
      assertEquals((error!.error as { type?: string }).type, 'rate_limit_error');

      // 已经发出的文本必须保留，不能被兜底内容覆盖
      const delta = events.find((event) => event.type === 'content_block_delta');
      assertExists(delta);
      assertEquals((delta!.delta as { text?: string }).text, '已经开始回答');
    });
  } finally {
    globalThis.fetch = originalFetch;
    resetSiderAvailability();
  }
});
