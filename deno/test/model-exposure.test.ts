import { Hono } from 'hono';
import { getAllModels, getModelById, mapModelName } from '../src/config/models.ts';
import modelsRouter from '../src/routes/models.ts';

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

function assertArray(value: unknown): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new Error('assert failed: expected array');
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

function idsFromOpenAIModelList(body: { data?: Array<{ id?: string }> }): string[] {
  return (body.data || []).map((model) => model.id || '');
}

function idsFromGeminiModelList(body: { models?: Array<{ name?: string }> }): string[] {
  return (body.models || []).map((model) => (model.name || '').replace(/^models\//, ''));
}

function siderStreamResponse(model: string): Response {
  const messageStart = {
    code: 0,
    msg: 'ok',
    data: {
      type: 'message_start',
      model,
      message_start: {
        cid: 'cid_model_exposure',
        user_message_id: 'user_model_exposure',
        assistant_message_id: 'assistant_model_exposure',
      },
    },
  };
  const text = {
    code: 0,
    msg: 'ok',
    data: { type: 'text', model, text: 'OK' },
  };

  return new Response(
    `data: ${JSON.stringify(messageStart)}\n\ndata: ${JSON.stringify(text)}\n\ndata: [DONE]\n\n`,
    {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    },
  );
}

Deno.test('model catalog exposes all upstream models for Anthropic/OpenAI discovery', async () => {
  const models = getAllModels();
  const ids = models.map((model) => model.id);

  assertEquals(models.length, 54);
  for (
    const id of [
      'claude-sonnet-4.6',
      'gpt-5.5-think',
      'gemini-3.5-flash',
      'deepseek-v4-pro-think',
      'grok-4',
      'glm-5',
      'qwen3-max',
      'kimi-k2',
      'llama-3.1-405b',
      'sider',
    ]
  ) {
    assertEquals(ids.includes(id), true);
    assertExists(getModelById(id));
  }

  assertEquals(mapModelName('gpt-5.5-think'), 'gpt-5.5-think');
  assertEquals(mapModelName('gemini-3.5-flash'), 'gemini-3.5-flash');
  assertEquals(mapModelName('claude-opus-4.5'), 'claude-opus-4.6');

  const app = new Hono();
  app.route('/v1/models', modelsRouter);

  const listResponse = await app.request('/v1/models');
  assertEquals(listResponse.status, 200);
  const list = await listResponse.json() as { data?: Array<{ id?: string }> };
  const listIds = idsFromOpenAIModelList(list);
  assertEquals(listIds.length, 54);
  assertEquals(listIds.includes('gpt-5.5-think'), true);
  assertEquals(listIds.includes('gemini-3.5-flash'), true);

  const detailResponse = await app.request('/v1/models/gpt-5.5-think');
  assertEquals(detailResponse.status, 200);
  const detail = await detailResponse.json() as { id?: string; siderModel?: string };
  assertEquals(detail.id, 'gpt-5.5-think');
  assertEquals(detail.siderModel, 'gpt-5.5-think');
});

Deno.test('Gemini model discovery exposes every upstream model', async () => {
  await withEnv({
    AUTH_TOKEN: 'test-token-12345',
    SIDER_AUTH_TOKEN: 'sider-token',
    DEEPSEEK_API_KEY: undefined,
  }, async () => {
    const protocolModule = await import(`../src/routes/protocols.ts?test=${crypto.randomUUID()}`);
    const app = new Hono();
    app.route('/', protocolModule.default);

    const listResponse = await app.request('/v1beta/models');
    assertEquals(listResponse.status, 200);
    const list = await listResponse.json() as { models?: Array<{ name?: string }> };
    const ids = idsFromGeminiModelList(list);
    assertEquals(ids.length, 54);
    assertEquals(ids.includes('gpt-5.5-think'), true);
    assertEquals(ids.includes('gemini-3.5-flash'), true);

    const detailResponse = await app.request('/v1beta/models/gpt-5.5-think');
    assertEquals(detailResponse.status, 200);
    const detail = await detailResponse.json() as {
      name?: string;
      supportedGenerationMethods?: unknown;
    };
    assertEquals(detail.name, 'models/gpt-5.5-think');
    assertArray(detail.supportedGenerationMethods);
    assertEquals(detail.supportedGenerationMethods.includes('generateContent'), true);
    assertEquals(detail.supportedGenerationMethods.includes('streamGenerateContent'), true);
  });
});

Deno.test('non-Claude upstream models work through Anthropic, OpenAI, Responses and Gemini', async () => {
  const originalFetch = globalThis.fetch;
  const upstreamModels: string[] = [];

  try {
    await withEnv({
      AUTH_TOKEN: 'test-token-12345',
      SIDER_AUTH_TOKEN: 'sider-token',
      DEFAULT_BACKEND: 'sider',
      PREFER_SIDER_FOR_CHAT: 'true',
      DEEPSEEK_API_KEY: undefined,
    }, async () => {
      globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string) as { model?: string };
        upstreamModels.push(body.model || '');
        return Promise.resolve(siderStreamResponse(body.model || 'unknown'));
      }) as typeof fetch;

      const messagesModule = await import(
        `../src/routes/messages-hybrid.ts?test=${crypto.randomUUID()}`
      );
      const protocolModule = await import(`../src/routes/protocols.ts?test=${crypto.randomUUID()}`);
      const app = new Hono();
      app.route('/v1/messages', messagesModule.hybridMessagesRouter);
      app.route('/', protocolModule.default);

      const authHeaders = {
        authorization: 'Bearer test-token-12345',
        'content-type': 'application/json',
      };

      const anthropicResponse = await app.request('/v1/messages?beta=true', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          model: 'gpt-5.5-think',
          messages: [{ role: 'user', content: 'hello' }],
          max_tokens: 16,
        }),
      });
      assertEquals(anthropicResponse.status, 200);
      const anthropic = await anthropicResponse.json() as { model?: string };
      assertEquals(anthropic.model, 'gpt-5.5-think');

      const chatResponse = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          model: 'gemini-3.5-flash',
          messages: [{ role: 'user', content: 'hello' }],
          max_tokens: 16,
        }),
      });
      assertEquals(chatResponse.status, 200);
      const chat = await chatResponse.json() as { model?: string; choices?: unknown };
      assertEquals(chat.model, 'gemini-3.5-flash');
      assertExists(chat.choices);

      const responsesResponse = await app.request('/v1/responses', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          model: 'deepseek-v4-pro-think',
          input: 'hello',
          max_output_tokens: 16,
        }),
      });
      assertEquals(responsesResponse.status, 200);
      const responses = await responsesResponse.json() as { model?: string; output?: unknown };
      assertEquals(responses.model, 'deepseek-v4-pro-think');
      assertExists(responses.output);

      const geminiResponse = await app.request('/v1beta/models/grok-4:generateContent', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
          generationConfig: { maxOutputTokens: 16 },
        }),
      });
      assertEquals(geminiResponse.status, 200);
      const gemini = await geminiResponse.json() as { candidates?: unknown };
      assertExists(gemini.candidates);

      assertEquals(upstreamModels.length, 4);
      assertEquals(upstreamModels[0], 'gpt-5.5-think');
      assertEquals(upstreamModels[1], 'gemini-3.5-flash');
      assertEquals(upstreamModels[2], 'deepseek-v4-pro-think');
      assertEquals(upstreamModels[3], 'grok-4');
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
