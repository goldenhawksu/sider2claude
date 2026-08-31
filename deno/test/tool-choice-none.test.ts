/**
 * `tool_choice: none` 的服务端实现。
 *
 * 背景：probe 实测（deno/tools/probe-deepseek-tool-choice.ts）上游
 * `glm-5.3-flash` **完全忽略 tool_choice**——no/auto/any/tool/none 五种形态返回
 * 完全一样的 `tool_use`。所以 `none` 只能在本服务层兑现，透传是没有用的。
 *
 * 实现取向：`none` 时**不向上游发送 tools**。
 *
 * 为什么不用注入文本指令："请不要调用工具" 这类提示对忽略 tool_choice 的上游
 * 同样只是建议，实测它照调不误。工具不可见才是唯一可靠的做法。
 *
 * 代价是这一轮的上游 prompt 缓存前缀会变（tools 渲染在最前面，见
 * prompt-cache.test.ts）。这是 `none` 语义的必要开销：调用方明确要求「这轮别用
 * 工具」，正确性优先于缓存命中率。其余 tool_choice 形态一律照常发送 tools，
 * 缓存行为不受影响。
 */

import { AnthropicApiAdapter } from '../src/adapters/anthropic-adapter.ts';
import type { AnthropicRequest } from '../src/types/anthropic.ts';

function assertEquals<T>(actual: T, expected: T, what = '值') {
  if (actual !== expected) {
    throw new Error(`${what}：期望 ${String(expected)}，实际 ${String(actual)}`);
  }
}

function assert(condition: boolean, what: string) {
  if (!condition) {
    throw new Error(`断言失败：${what}`);
  }
}

const TOOL = {
  name: 'get_weather',
  description: '查询天气',
  input_schema: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
};

/** 捕获发往上游的请求体；upstreamContent 可定制上游返回的内容块。 */
async function captureUpstream(
  request: AnthropicRequest,
  upstreamContent: unknown[] = [{ type: 'text', text: '今天上海多云。' }],
): Promise<{
  upstream: AnthropicRequest & Record<string, unknown>;
  response: Awaited<ReturnType<AnthropicApiAdapter['sendRequest']>>;
}> {
  const originalFetch = globalThis.fetch;
  let captured: (AnthropicRequest & Record<string, unknown>) | undefined;

  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    captured = JSON.parse(init?.body as string);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: 'msg_tc_1',
          type: 'message',
          role: 'assistant',
          model: 'glm-5.3-flash',
          content: upstreamContent,
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  }) as typeof fetch;

  try {
    const adapter = new AnthropicApiAdapter({
      enabled: true,
      provider: 'deepseek',
      baseUrl: 'https://api.z.ai/api/anthropic',
      apiKey: 'test-key',
      model: 'glm-5.3-flash',
    });
    const response = await adapter.sendRequest(request);
    if (!captured) throw new Error('未捕获到上游请求');
    return { upstream: captured, response };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

Deno.test('tool_choice none：不向上游发送 tools（上游忽略 tool_choice，只能靠隐藏工具）', async () => {
  const { upstream } = await captureUpstream({
    model: 'claude-haiku-4.5',
    max_tokens: 128,
    tools: [TOOL],
    tool_choice: { type: 'none' },
    messages: [{ role: 'user', content: '上海天气怎么样？' }],
  } as unknown as AnthropicRequest);

  assertEquals(upstream.tools, undefined, 'none 时 tools 必须摘掉');
  assertEquals(upstream.tool_choice, undefined, '没有 tools 时 tool_choice 无意义，一并摘掉');
});

Deno.test('tool_choice none：不注入工具协议提示词（工具都不可见了，提示无处可依）', async () => {
  const { upstream } = await captureUpstream({
    model: 'claude-haiku-4.5',
    max_tokens: 128,
    tools: [TOOL],
    tool_choice: { type: 'none' },
    messages: [{ role: 'user', content: '上海天气怎么样？' }],
  } as unknown as AnthropicRequest);

  const system = String(upstream.system ?? '');
  assertEquals(system.includes('Tool protocol:'), false, '不应注入工具协议提示词');
  assertEquals(system.includes('get_weather'), false, '不应泄漏工具名');
});

Deno.test('tool_choice none：即便上游吐出文本形式的工具调用，也不还原成 tool_use', async () => {
  // 上游忽略指令、按转录格式吐了一行"调用"。none 语义下这必须保持文本，
  // 否则调用方明确禁止工具却仍然拿到 tool_use，等于指令被无视。
  const { response } = await captureUpstream(
    {
      model: 'claude-haiku-4.5',
      max_tokens: 128,
      tools: [TOOL],
      tool_choice: { type: 'none' },
      messages: [{ role: 'user', content: '上海天气怎么样？' }],
    } as unknown as AnthropicRequest,
    [{ type: 'text', text: '[tool_use:get_weather] id=toolu_x input={"city":"上海"}' }],
  );

  const hasToolUse = response.content.some((b) => b.type === 'tool_use');
  assertEquals(hasToolUse, false, 'none 时不得还原出 tool_use');
  assertEquals(response.stop_reason, 'end_turn', 'stop_reason 不应被改判为 tool_use');
});

Deno.test('tool_choice auto/any：tools 照常发送（回归保护，缓存前缀不受影响）', async () => {
  for (const choice of [{ type: 'auto' }, { type: 'any' }] as const) {
    const { upstream } = await captureUpstream({
      model: 'claude-haiku-4.5',
      max_tokens: 128,
      tools: [TOOL],
      tool_choice: choice,
      messages: [{ role: 'user', content: '上海天气怎么样？' }],
    } as unknown as AnthropicRequest);

    assert(Array.isArray(upstream.tools), `${choice.type} 时 tools 必须照常发送`);
    assertEquals((upstream.tools as unknown[]).length, 1, `${choice.type} 的 tools 数量`);
    assertEquals(
      (upstream.tool_choice as { type: string } | undefined)?.type,
      choice.type,
      `${choice.type} 应原生透传`,
    );
  }
});

Deno.test('tool_choice 缺省：tools 照常发送', async () => {
  const { upstream } = await captureUpstream({
    model: 'claude-haiku-4.5',
    max_tokens: 128,
    tools: [TOOL],
    messages: [{ role: 'user', content: '上海天气怎么样？' }],
  } as unknown as AnthropicRequest);

  assert(Array.isArray(upstream.tools), '缺省时 tools 必须照常发送');
});

Deno.test('tool_choice none：没有 tools 的请求不受影响', async () => {
  const { upstream } = await captureUpstream({
    model: 'claude-haiku-4.5',
    max_tokens: 128,
    tool_choice: { type: 'none' },
    messages: [{ role: 'user', content: '你好' }],
  } as unknown as AnthropicRequest);

  assertEquals(upstream.tools, undefined, '本来就没有 tools');
  assertEquals(upstream.tool_choice, undefined, 'tool_choice 一并摘掉');
});
