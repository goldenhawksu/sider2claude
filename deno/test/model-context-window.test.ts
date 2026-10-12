import { SiderClient } from '../src/utils/sider-client.ts';
import { convertAnthropicToSiderSync } from '../src/utils/request-converter.ts';
import { createAccumulatorCallbacks } from '../src/utils/sse-line-reader.ts';
import { AnthropicApiAdapter } from '../src/adapters/anthropic-adapter.ts';
import type { AnthropicRequest } from '../src/types/anthropic.ts';
import {
  isSiderCooling,
  recordSiderQuotaExhausted,
  resetSiderAvailability,
  siderCooldownRemainingMs,
} from '../src/utils/sider-availability.ts';
import {
  canUseSider,
  consumeSiderSlot,
  getSiderThrottleSnapshot,
  recordSiderOversize,
  resetSiderThrottle,
} from '../src/utils/sider-throttle.ts';

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`期望${JSON.stringify(expected)}，实际${JSON.stringify(actual)}`);
  }
}

Deno.test('发送边界：非流式和流式始终使用Sider原名，不修改调用方请求', async () => {
  const original = globalThis.fetch;
  const request = convertAnthropicToSiderSync({
    model: 'claude-sonnet-5.5',
    messages: [{ role: 'user', content: '测试' }],
  });
  request.model = 'claude-sonnet-5.5[1M]';
  request.chat_models = ['claude-opus-5.5[1m]', 'claude-haiku-4.5'];
  try {
    globalThis.fetch = ((_url, init) => {
      const body = JSON.parse(String(init?.body));
      equal(body.model, 'claude-sonnet-5.5');
      equal(body.chat_models, ['claude-opus-5.5', 'claude-haiku-4.5']);
      equal(new Headers(init?.headers).has('anthropic-beta'), false);
      return Promise.resolve(
        new Response(
          'data: ' +
            JSON.stringify({
              code: 0,
              msg: 'ok',
              data: { type: 'text', model: body.model, text: '测试成功' },
            }) + '\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      );
    }) as typeof fetch;
    const client = new SiderClient();
    equal((await client.chat(request, 'test-token')).model, 'claude-sonnet-5.5');
    const { callbacks, result } = createAccumulatorCallbacks();
    await client.chatStream(request, 'test-token', callbacks);
    equal(result.textParts.join(''), '测试成功');
    equal(request.model, 'claude-sonnet-5.5[1M]');
    equal(request.chat_models[0], 'claude-opus-5.5[1m]');
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test('保守及自适应限流：1M标签与原名共享额度，不同模型保持隔离', () => {
  const model = 'claude-sonnet-5.5', now = 100_000;
  try {
    recordSiderQuotaExhausted(model + '[1m]', now, 60_000);
    equal(isSiderCooling(model, now), true);
    equal(siderCooldownRemainingMs(model + '[200K]', now), 60_000);
    equal(isSiderCooling('claude-opus-5.5', now), false);
    for (let i = 0; i < 12; i++) consumeSiderSlot(model + '[1m]', now);
    equal(canUseSider(model, 100, now).ok, false);
    equal(canUseSider('claude-opus-5.5', 100, now).ok, true);
    recordSiderOversize(model, 4000, now);
    equal(canUseSider(model + '[200k]', 4000, now).ok, false);
    equal(getSiderThrottleSnapshot(now).filter((s) => s.model.startsWith(model)).length, 1);
  } finally {
    resetSiderAvailability();
    resetSiderThrottle();
  }
});

Deno.test('161消息27工具大请求：兼容后端保留全文，对外模型标签不影响结束语义', async () => {
  const original = globalThis.fetch;
  const messages: AnthropicRequest['messages'] = Array.from({ length: 161 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `${i}:${'long-history-'.repeat(440)}:END_${i}`,
  }));
  const tools: AnthropicRequest['tools'] = Array.from({ length: 27 }, (_, i) => ({
    name: i ? `Tool_${i}` : 'Read',
    input_schema: { type: 'object', properties: { file_path: { type: 'string' } } },
  }));
  const request = { model: 'claude-sonnet-5.5[1m]', messages, tools, max_tokens: 16384 };
  let count = 0;
  try {
    globalThis.fetch = ((_url, init) => {
      count++;
      const body = JSON.parse(String(init?.body));
      equal(body.model, 'glm-5.3-flash');
      equal(body.messages, messages);
      equal(body.tools, tools);
      equal(body.stream, true);
      return Promise.resolve(
        new Response(
          [
            {
              type: 'message_start',
              message: {
                id: 'large-window',
                model: body.model,
                usage: { input_tokens: 1000, output_tokens: 0 },
                content: [],
              },
            },
            {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'tool_use', id: 'read-large', name: 'Read', input: {} },
            },
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'input_json_delta', partial_json: '{"file_path":"/repo/source.md"}' },
            },
            { type: 'content_block_stop', index: 0 },
            {
              type: 'message_delta',
              delta: { stop_reason: 'tool_use' },
              usage: { output_tokens: 20 },
            },
            { type: 'message_stop' },
          ].map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      );
    }) as typeof fetch;
    const result = await new AnthropicApiAdapter({
      enabled: true,
      provider: 'anthropic-compatible',
      baseUrl: 'https://large.example',
      apiKey: 'test',
      model: 'glm-5.3-flash',
    }).sendRequest(request);
    equal(count, 1);
    equal(result.model, request.model);
    equal(result.stop_reason, 'tool_use');
    equal(result.content[0], {
      type: 'tool_use',
      id: 'read-large',
      name: 'Read',
      input: { file_path: '/repo/source.md' },
    });
  } finally {
    globalThis.fetch = original;
  }
});
