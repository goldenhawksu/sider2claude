/**
 * 小预算下的 thinking 抑制。
 *
 * 问题：上游 `glm-5.3-flash` 默认开着 thinking，而 thinking 与正文共享
 * `max_tokens` 预算。probe 实测（deno/tools/probe-upstream-max-tokens.ts）：
 *
 *     max_tokens=16   -> out_tok=16   blocks=[thinking]  正文 0 字
 *     max_tokens=64   -> out_tok=64   blocks=[thinking]  正文 0 字
 *     max_tokens=256  -> out_tok=256  blocks=[thinking]  正文 0 字
 *     max_tokens=1024 -> out_tok=629  blocks=[thinking,text] 正文 66 字
 *
 * 也就是说，调用方给个小 `max_tokens`（想要一句简短回答）会拿到一个
 * **HTTP 200、stop_reason=max_tokens、却一个字正文都没有**的响应。
 *
 * 解法：同一份 probe 证明 `thinking:{type:'disabled'}` 有效——`max_tokens=100`
 * 配上它就能正常产出 63 字正文并 `end_turn`。其余开关（`budget_tokens`、
 * `reasoning.enabled`）实测无效。
 *
 * 取向：**只在预算确实装不下时才关**，而不是一律关掉。
 * - thinking 是 glm 推理质量的一部分，无差别关掉会波及工具调用准确率；
 * - 调用方显式要了 extended thinking 的，尊重它，哪怕预算小也不动。
 */

import { AnthropicApiAdapter } from '../src/adapters/anthropic-adapter.ts';
import type { AnthropicRequest } from '../src/types/anthropic.ts';

function assertEquals<T>(actual: T, expected: T, what = '值') {
  if (actual !== expected) {
    throw new Error(`${what}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

async function capture(request: Partial<AnthropicRequest>) {
  const originalFetch = globalThis.fetch;
  let sent: (AnthropicRequest & Record<string, unknown>) | undefined;

  globalThis.fetch = ((_i: string | URL | Request, init?: RequestInit) => {
    sent = JSON.parse(init?.body as string);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: 'msg_mt_1',
          type: 'message',
          role: 'assistant',
          model: 'glm-5.3-flash',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 5, output_tokens: 2 },
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
    await adapter.sendRequest({
      model: 'claude-haiku-4.5',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'hi' }],
      ...request,
    } as AnthropicRequest);
    return sent!;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

Deno.test('小预算：max_tokens 不足以容纳 thinking 时，显式关掉 thinking', async () => {
  const sent = await capture({ max_tokens: 64 });
  assertEquals(
    JSON.stringify(sent.thinking),
    JSON.stringify({ type: 'disabled' }),
    '小预算必须关 thinking，否则正文一个字都出不来',
  );
});

Deno.test('小预算：阈值以上保持原样，不动上游的默认推理行为', async () => {
  const sent = await capture({ max_tokens: 4096 });
  assertEquals(sent.thinking, undefined, '大预算不该关 thinking——那会波及推理质量');
});

Deno.test('小预算：调用方显式要了 extended thinking 就尊重它，哪怕预算小', async () => {
  const sent = await capture({
    max_tokens: 64,
    thinking: { type: 'enabled', budget_tokens: 1024 },
  } as Partial<AnthropicRequest>);

  assertEquals(
    sent.thinking,
    undefined,
    '客户端要 thinking 时不注入 disabled；thinking 字段本身仍按老规矩摘掉（上游会校验 passback）',
  );
});

Deno.test('小预算：边界值恰好在阈值上不关 thinking', async () => {
  const sent = await capture({ max_tokens: 1024 });
  assertEquals(sent.thinking, undefined, '阈值本身算「够用」——probe 实测 1024 能产出正文');
});

Deno.test('小预算：阈值下方一格就关', async () => {
  const sent = await capture({ max_tokens: 1023 });
  assertEquals(JSON.stringify(sent.thinking), JSON.stringify({ type: 'disabled' }), '低于阈值');
});

Deno.test('小预算：没有 max_tokens 的请求不做处理', async () => {
  // max_tokens 是 Anthropic 必填字段，但防御性地别在缺省时误判成 0 而关掉 thinking
  const sent = await capture({ max_tokens: undefined } as Partial<AnthropicRequest>);
  assertEquals(sent.thinking, undefined, '缺省时不注入');
});
