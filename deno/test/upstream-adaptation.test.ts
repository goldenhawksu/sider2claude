/**
 * 上游能力学习在 adapter 里的落地。
 *
 * 目标是「换上游前端无感」：`DEEPSEEK_BASE_URL` 指向 GLM 还是 DeepSeek，调用方
 * 都不该感觉到差别，也不该被要求配任何开关。
 *
 * 落地方式分两步：
 * 1. **首次撞上就自动重试**——观察到「thinking 吃光预算」的空响应时，立刻带
 *    `thinking:{type:'disabled'}` 重发一次，把正常内容交给调用方。那个空响应
 *    本来就是废的，重试是净收益。
 * 2. **学到之后不再撞**——同一上游后续的小预算请求直接注入 `disabled`，
 *    没有额外往返。
 *
 * 对没有这个缺陷的上游（可能包括 DeepSeek 官方），判据永不命中，
 * 整套机制零影响。
 */

import { AnthropicApiAdapter } from '../src/adapters/anthropic-adapter.ts';
import { resetUpstreamCapabilities } from '../src/utils/upstream-capabilities.ts';
import type { AnthropicRequest } from '../src/types/anthropic.ts';

function assertEquals<T>(actual: T, expected: T, what = '值') {
  if (actual !== expected) {
    throw new Error(`${what}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

function assert(condition: boolean, what: string) {
  if (!condition) throw new Error(`断言失败：${what}`);
}

const BASE_URL = 'https://api.z.ai/api/anthropic';
const MODEL = 'glm-5.3-flash';

function newAdapter() {
  return new AnthropicApiAdapter({
    enabled: true,
    provider: 'anthropic-compatible',
    baseUrl: BASE_URL,
    apiKey: 'test-key',
    model: MODEL,
  });
}

/** 上游返回「thinking 吃光预算」的空响应。 */
const ATE_BUDGET = {
  id: 'msg_ate',
  type: 'message',
  role: 'assistant',
  model: MODEL,
  content: [{ type: 'thinking', thinking: '想了很久很久……' }],
  stop_reason: 'max_tokens',
  usage: { input_tokens: 10, output_tokens: 64 },
};

/** 关掉 thinking 后的正常响应。 */
const GOOD = {
  id: 'msg_good',
  type: 'message',
  role: 'assistant',
  model: MODEL,
  content: [{ type: 'text', text: '递归就是函数调用自身。' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 10, output_tokens: 12 },
};

/** 按序返回预设响应，并记录每次请求体。 */
function stubUpstream(responses: Array<unknown | { status: number; body: unknown }>) {
  const sent: Array<AnthropicRequest & Record<string, unknown>> = [];
  let i = 0;
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(init?.body as string));
    const next = responses[Math.min(i++, responses.length - 1)] as
      | { status: number; body: unknown }
      | unknown;
    const isEnvelope = !!next && typeof next === 'object' && 'status' in (next as object);
    const status = isEnvelope ? (next as { status: number }).status : 200;
    const body = isEnvelope ? (next as { body: unknown }).body : next;
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof fetch;
  return sent;
}

function capTest(name: string, fn: () => Promise<void>) {
  Deno.test(name, async () => {
    const originalFetch = globalThis.fetch;
    resetUpstreamCapabilities();
    try {
      await fn();
    } finally {
      globalThis.fetch = originalFetch;
      resetUpstreamCapabilities();
    }
  });
}

const ASK = {
  model: 'claude-haiku-4.5',
  max_tokens: 64,
  messages: [{ role: 'user', content: '什么是递归？' }],
} as unknown as AnthropicRequest;

capTest('首次撞上 thinking 吃光预算时自动重试，调用方拿到正常内容', async () => {
  const sent = stubUpstream([ATE_BUDGET, GOOD]);

  const response = await newAdapter().sendRequest(ASK);

  assertEquals(sent.length, 2, '应当重试一次');
  assertEquals(sent[0].thinking, undefined, '首次请求不注入——还没有证据');
  assertEquals(
    JSON.stringify(sent[1].thinking),
    JSON.stringify({ type: 'disabled' }),
    '重试时才注入 disabled',
  );
  assertEquals(
    (response.content[0] as { text: string }).text,
    '递归就是函数调用自身。',
    '调用方拿到的是重试后的正常内容，对这次修正无感',
  );
  assertEquals(response.stop_reason, 'end_turn', 'stop_reason 取重试结果');
});

capTest('学到之后，同一上游的小预算请求直接注入，不再多一次往返', async () => {
  // 第一轮：撞上 + 重试
  stubUpstream([ATE_BUDGET, GOOD]);
  await newAdapter().sendRequest(ASK);

  // 第二轮：应当一次到位
  const sent = stubUpstream([GOOD]);
  await newAdapter().sendRequest(ASK);

  assertEquals(sent.length, 1, '已经学到了，不该再撞一次');
  assertEquals(
    JSON.stringify(sent[0].thinking),
    JSON.stringify({ type: 'disabled' }),
    '直接注入',
  );
});

capTest('上游拒绝 disabled 时返回原响应，并记住不再尝试', async () => {
  const sent = stubUpstream([
    ATE_BUDGET,
    { status: 400, body: { error: { message: 'thinking.type disabled is not supported' } } },
  ]);

  const response = await newAdapter().sendRequest(ASK);

  assertEquals(sent.length, 2, '试过一次重试');
  assertEquals(response.stop_reason, 'max_tokens', '重试失败就把原响应交回去，不要连原结果都丢了');

  // 后续请求不该再注入，也不该再重试
  const sent2 = stubUpstream([ATE_BUDGET]);
  await newAdapter().sendRequest(ASK);
  assertEquals(sent2.length, 1, '已知不支持就别再试');
  assertEquals(sent2[0].thinking, undefined, '不再注入');
});

capTest('正常响应不触发任何重试（无缺陷的上游零影响）', async () => {
  const sent = stubUpstream([GOOD]);

  await newAdapter().sendRequest(ASK);

  assertEquals(sent.length, 1, '不该重试');
  assertEquals(sent[0].thinking, undefined, '不该注入');
});

capTest('正常的 max_tokens 截断（有正文）不被误判成缺陷', async () => {
  const truncated = {
    ...GOOD,
    content: [{ type: 'thinking', thinking: '想想' }, { type: 'text', text: '递归是指……' }],
    stop_reason: 'max_tokens',
  };
  const sent = stubUpstream([truncated]);

  await newAdapter().sendRequest(ASK);

  assertEquals(sent.length, 1, '有正文说明预算够用，是规范的截断，不该重试');
});

capTest('调用方显式要了 extended thinking 时不重试也不注入', async () => {
  const sent = stubUpstream([ATE_BUDGET, GOOD]);

  await newAdapter().sendRequest({
    ...ASK,
    thinking: { type: 'enabled', budget_tokens: 1024 },
  } as unknown as AnthropicRequest);

  assertEquals(sent.length, 1, '调用方自己要的推理，预算怎么分是它的选择，不要替它改');
});

capTest('重试沿用同一份请求体，只多一个 thinking 字段', async () => {
  const sent = stubUpstream([ATE_BUDGET, GOOD]);

  await newAdapter().sendRequest({
    ...ASK,
    system: '你是一个助手',
    tools: [{
      name: 'get_weather',
      description: '查天气',
      input_schema: { type: 'object', properties: { city: { type: 'string' } } },
    }],
  } as unknown as AnthropicRequest);

  assertEquals(sent.length, 2, '重试一次');
  const { thinking: _t1, ...first } = sent[0];
  const { thinking: _t2, ...second } = sent[1];
  assertEquals(
    JSON.stringify(second),
    JSON.stringify(first),
    '除 thinking 外必须逐字节一致——否则上游 prompt 缓存在重试时也断掉',
  );
});

capTest('能力按上游隔离：换 baseUrl 后重新观察', async () => {
  stubUpstream([ATE_BUDGET, GOOD]);
  await newAdapter().sendRequest(ASK);

  const other = new AnthropicApiAdapter({
    enabled: true,
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/anthropic',
    apiKey: 'test-key',
    model: 'deepseek-v4-flash',
  });
  const sent = stubUpstream([GOOD]);
  await other.sendRequest(ASK);

  assertEquals(sent[0].thinking, undefined, '换了上游就该重新观察，不带着上一家的结论');
});
