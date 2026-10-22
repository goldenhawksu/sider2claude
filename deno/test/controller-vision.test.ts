import { Hono } from 'hono';
import { getUsageSnapshot } from '../src/utils/usage-stats.ts';

function equal(actual: unknown, expected: unknown) {
  if (actual !== expected) throw new Error(`期望${expected}，实际${actual}`);
}

Deno.test('P0主控：直接图文JSON和SSE保留视觉兼容旁路，图片原样透传', async () => {
  const vars = {
    AUTH_TOKEN: 'p0-vision',
    SIDER_AUTH_TOKEN: 'unused',
    DEEPSEEK_API_KEY: 'test',
    DEEPSEEK_BASE_URL: 'https://vision.example',
    DEEPSEEK_MODEL: 'glm-5.3-flash',
    SIDER_CONTROLLER: 'true',
    SIDER_CONTROLLER_STREAMING: 'true',
  };
  const previous = new Map(Object.keys(vars).map((key) => [key, Deno.env.get(key)]));
  const original = globalThis.fetch;
  for (const [key, value] of Object.entries(vars)) Deno.env.set(key, value);
  try {
    globalThis.fetch = ((url, init) => {
      equal(String(url).startsWith('https://vision.example/'), true);
      const body = JSON.parse(String(init?.body));
      equal(
        body.messages[0].content.find((block: { type: string }) => block.type === 'image').source
          .data,
        'image-sentinel',
      );
      const events = [
        {
          type: 'message_start',
          message: {
            id: 'vision-1',
            type: 'message',
            role: 'assistant',
            model: 'glm-5.3-flash',
            content: [],
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '红色' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
        { type: 'message_stop' },
      ];
      return Promise.resolve(
        new Response(
          events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(
            '',
          ),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      );
    }) as typeof fetch;
    const { hybridMessagesRouter } = await import('../src/routes/messages-hybrid.ts?p0-vision');
    const app = new Hono();
    app.route('/v1/messages', hybridMessagesRouter);
    for (const stream of [false, true]) {
      const response = await app.request('/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': 'p0-vision', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-5.5',
          max_tokens: 64,
          stream,
          messages: [{
            role: 'user',
            content: [{
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'image-sentinel' },
            }, { type: 'text', text: '颜色？' }],
          }],
        }),
      });
      equal(response.status, 200);
      equal(response.headers.get('x-sider-controller'), null);
      equal((await response.text()).includes('红色'), true);
      equal(getUsageSnapshot().recent[0].actualModel, 'glm-5.3-flash');
      equal(getUsageSnapshot().recent[0].mode, 'hybrid');
    }
  } finally {
    globalThis.fetch = original;
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
});
