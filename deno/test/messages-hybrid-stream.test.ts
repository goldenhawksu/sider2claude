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
      assertEquals(replayResponse.headers.get('X-Duplicate-Replay'), 'true');
      assertEquals(upstreamCalls, 1);
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
