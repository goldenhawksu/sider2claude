import { AnthropicApiAdapter } from '../src/adapters/anthropic-adapter.ts';
import type { AnthropicRequest } from '../src/types/anthropic.ts';

function assertEquals<T>(actual: T, expected: T) {
  if (actual !== expected) {
    throw new Error(`断言失败：期望 ${String(expected)}，实际 ${String(actual)}`);
  }
}

function assertExists(value: unknown) {
  if (value === undefined || value === null) {
    throw new Error('断言失败：期望值存在');
  }
}

Deno.test('DeepSeek 适配器：用 Anthropic 兼容协议补齐工具能力，并保持对外 Claude 模型名', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit; body: AnthropicRequest }> = [];

  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString();
    const body = JSON.parse(init?.body as string) as AnthropicRequest;
    calls.push({ url, init, body });

    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: 'msg_deepseek_1',
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [{
            type: 'tool_use',
            id: 'toolu_1',
            name: 'Bash',
            input: { command: 'pwd' },
          }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
  }) as typeof fetch;

  try {
    const adapter = new AnthropicApiAdapter({
      enabled: true,
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/anthropic',
      apiKey: 'deepseek-token',
      model: 'deepseek-v4-flash',
    });

    const response = await adapter.sendRequest({
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'user', content: 'run pwd' }],
      max_tokens: 128,
      tools: [{
        name: 'Bash',
        description: 'Run shell',
        input_schema: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
      }],
    });

    assertEquals(calls.length, 1);
    assertEquals(calls[0].url, 'https://api.deepseek.com/anthropic/v1/messages');
    assertEquals(calls[0].body.model, 'deepseek-v4-flash');
    assertEquals(calls[0].body.tools?.[0].name, 'Bash');

    const headers = calls[0].init?.headers as Record<string, string>;
    assertEquals(headers.Authorization, 'Bearer deepseek-token');
    assertEquals(headers['anthropic-version'], '2023-06-01');

    assertEquals(response.model, 'claude-sonnet-4.6');
    assertEquals(response.stop_reason, 'tool_use');
    assertExists(response.content.find((block) => block.type === 'tool_use'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('DeepSeek 适配器：兼容真实上游返回的 thinking 内容块', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as AnthropicRequest;

    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: 'msg_deepseek_thinking_1',
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [{
            type: 'thinking',
            thinking: '先分析问题。',
            signature: 'sig_1',
          }, {
            type: 'text',
            text: '这是最终回答。',
          }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 8, output_tokens: 6 },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
  }) as typeof fetch;

  try {
    const adapter = new AnthropicApiAdapter({
      enabled: true,
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/anthropic',
      apiKey: 'deepseek-token',
      model: 'deepseek-v4-flash',
    });

    const response = await adapter.sendRequest({
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 128,
    });

    assertEquals(response.model, 'claude-sonnet-4.6');
    assertEquals(response.content[0].type, 'thinking');
    assertEquals(response.content[1].type, 'text');
    if (response.content[0].type === 'thinking') {
      assertEquals(response.content[0].thinking, '先分析问题。');
      assertEquals(response.content[0].signature, 'sig_1');
    }
    if (response.content[1].type === 'text') {
      assertEquals(response.content[1].text, '这是最终回答。');
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
