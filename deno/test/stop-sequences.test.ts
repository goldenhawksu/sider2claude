/**
 * `stop_sequences` 的服务端实现。
 *
 * 为什么不能透传给上游：probe 实测（deno/tools/probe-upstream-stop-sequences.ts）
 * 上游 `glm-5.3-flash` 有两个规范偏离——
 *
 * 1. 截断作用在 **thinking** 上。`stop_sequences:["3"]` 会让它在推理过程里撞到
 *    "3" 就整个停下，结果是 `content=[thinking]`、正文一个字都没有。常见字符
 *    几乎必然出现在推理里，等于「用了 stop_sequences 就大概率拿到空响应」。
 * 2. 命中后 `stop_reason` 仍报 `end_turn`、`stop_sequence` 为 null，
 *    而 Anthropic 规范要求 `stop_reason:"stop_sequence"` 并带上命中的那一个。
 *
 * Sider 通道则是另一个极端：完全不支持，"1 2 3 4 5" 原样输出。
 *
 * 所以截断放在本服务层做，两条通道走同一份实现，行为一致且符合规范：
 * 只作用于 **text 块**，thinking 不受影响。
 */

import { applyStopSequences } from '../src/utils/stop-sequences.ts';
import type { AnthropicResponseContent } from '../src/types/anthropic.ts';

function assertEquals<T>(actual: T, expected: T, what = '值') {
  if (actual !== expected) {
    throw new Error(`${what}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

function text(...parts: string[]): AnthropicResponseContent[] {
  return parts.map((t) => ({ type: 'text', text: t }));
}

function joinText(content: AnthropicResponseContent[]): string {
  return content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
}

Deno.test('stop_sequences：命中时截断到序列之前，并报出命中的序列', () => {
  const r = applyStopSequences(text('1 2 3 4 5'), ['3']);
  assertEquals(joinText(r.content), '1 2 ', '截断位置');
  assertEquals(r.matched, '3', '命中的序列');
});

Deno.test('stop_sequences：未命中时原样返回，不报 matched', () => {
  const r = applyStopSequences(text('1 2 3 4 5'), ['9']);
  assertEquals(joinText(r.content), '1 2 3 4 5', '内容不变');
  assertEquals(r.matched, undefined, '未命中');
});

Deno.test('stop_sequences：空或缺省的 stop_sequences 不做任何处理', () => {
  assertEquals(applyStopSequences(text('abc'), undefined).matched, undefined, 'undefined');
  assertEquals(applyStopSequences(text('abc'), []).matched, undefined, '空数组');
  assertEquals(joinText(applyStopSequences(text('abc'), []).content), 'abc', '内容不变');
});

Deno.test('stop_sequences：多个候选取最早出现的位置，而非声明顺序', () => {
  // "5" 声明在前，但 "4" 在文本里更早出现——必须按位置取，否则截断点会偏后
  const r = applyStopSequences(text('1 2 3 4 5'), ['5', '4']);
  assertEquals(joinText(r.content), '1 2 3 ', '截断位置');
  assertEquals(r.matched, '4', '命中的序列');
});

Deno.test('stop_sequences：thinking 块不参与匹配也不被截断（上游正是错在这里）', () => {
  const content: AnthropicResponseContent[] = [
    { type: 'thinking', thinking: '我先数一下 3 这个数字' },
    { type: 'text', text: '1 2 3 4 5' },
  ];
  const r = applyStopSequences(content, ['3']);

  const thinking = r.content.find((b) => b.type === 'thinking') as { thinking: string } | undefined;
  assertEquals(thinking?.thinking, '我先数一下 3 这个数字', 'thinking 必须完整保留');
  assertEquals(joinText(r.content), '1 2 ', '只截断正文');
  assertEquals(r.matched, '3', '命中的序列');
});

Deno.test('stop_sequences：跨多个 text 块时，命中之后的块整体丢弃', () => {
  const r = applyStopSequences(text('abc', 'de', 'STOP', 'fgh'), ['STOP']);
  assertEquals(joinText(r.content), 'abcde', '命中前的内容保留');
  assertEquals(r.matched, 'STOP', '命中的序列');
  assertEquals(r.content.filter((b) => b.type === 'text').length, 2, '命中后的块被丢弃');
});

Deno.test('stop_sequences：序列跨块边界时也能命中', () => {
  // 上游按 token 切块，一个序列很可能被劈在两个 text 块里
  const r = applyStopSequences(text('abcST', 'OPdef'), ['STOP']);
  assertEquals(joinText(r.content), 'abc', '跨块命中后的截断位置');
  assertEquals(r.matched, 'STOP', '命中的序列');
});

Deno.test('stop_sequences：文本开头即命中时产出空正文而非丢块', () => {
  // 客户端会遍历 content，突然少一个块比空字符串更容易踩空
  const r = applyStopSequences(text('STOPabc'), ['STOP']);
  assertEquals(joinText(r.content), '', '正文为空');
  assertEquals(r.matched, 'STOP', '命中的序列');
  assertEquals(r.content.length, 1, '仍保留一个 text 块');
});

Deno.test('stop_sequences：tool_use 块不受影响', () => {
  const content: AnthropicResponseContent[] = [
    { type: 'text', text: '让我查一下 3' },
    { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'echo 3' } },
  ];
  const r = applyStopSequences(content, ['3']);
  assertEquals(joinText(r.content), '让我查一下 ', '正文被截断');
  assertEquals(
    r.content.some((b) => b.type === 'tool_use'),
    true,
    'tool_use 保留——它不是自然语言输出，不该被 stop_sequence 切掉',
  );
});

Deno.test('stop_sequences：空字符串序列被忽略（否则会在位置 0 命中一切）', () => {
  const r = applyStopSequences(text('abc'), ['']);
  assertEquals(joinText(r.content), 'abc', '内容不变');
  assertEquals(r.matched, undefined, '空序列不算命中');
});

// ── 通道集成 ────────────────────────────────────────────────────────────────
//
// 截断必须发生在本服务层，且两条通道行为一致：命中时 `stop_reason` 报
// `stop_sequence`、`stop_sequence` 字段带上命中的那一个。上游给的
// `end_turn` + `null` 不能直接透传出去。

import { AnthropicApiAdapter } from '../src/adapters/anthropic-adapter.ts';
import type { AnthropicRequest } from '../src/types/anthropic.ts';

async function viaDeepSeek(
  request: Partial<AnthropicRequest>,
  upstreamText: string,
  upstreamThinking?: string,
) {
  const originalFetch = globalThis.fetch;
  let sent: (AnthropicRequest & Record<string, unknown>) | undefined;

  globalThis.fetch = ((_i: string | URL | Request, init?: RequestInit) => {
    sent = JSON.parse(init?.body as string);
    const content: unknown[] = [];
    if (upstreamThinking) content.push({ type: 'thinking', thinking: upstreamThinking });
    content.push({ type: 'text', text: upstreamText });
    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: 'msg_ss_1',
          type: 'message',
          role: 'assistant',
          model: 'glm-5.3-flash',
          content,
          // 上游的规范偏离：命中了也报 end_turn
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
    const response = await adapter.sendRequest({
      model: 'claude-haiku-4.5',
      max_tokens: 128,
      messages: [{ role: 'user', content: '只输出：1 2 3 4 5' }],
      ...request,
    } as AnthropicRequest);
    return { response, sent: sent! };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

Deno.test('stop_sequences 集成：DeepSeek 通道命中后 stop_reason 报 stop_sequence', async () => {
  const { response } = await viaDeepSeek({ stop_sequences: ['3'] }, '1 2 3 4 5');

  assertEquals(joinText(response.content), '1 2 ', '正文被截断');
  assertEquals(response.stop_reason, 'stop_sequence', 'stop_reason 必须改判');
  assertEquals(response.stop_sequence, '3', 'stop_sequence 必须带上命中的序列');
});

Deno.test('stop_sequences 集成：不把 stop_sequences 透传给上游（上游会截 thinking）', async () => {
  const { sent } = await viaDeepSeek({ stop_sequences: ['3'] }, '1 2 3 4 5');

  assertEquals(
    sent.stop_sequences,
    undefined,
    '必须由本服务层截断——透传给上游会让它在推理阶段就停下，正文变空',
  );
});

Deno.test('stop_sequences 集成：thinking 块完整保留，不被序列切掉', async () => {
  const { response } = await viaDeepSeek(
    { stop_sequences: ['3'] },
    '1 2 3 4 5',
    '我先想想 3 这个数',
  );

  const thinking = response.content.find((b) => b.type === 'thinking') as
    | { thinking: string }
    | undefined;
  assertEquals(thinking?.thinking, '我先想想 3 这个数', 'thinking 不受影响');
  assertEquals(response.stop_reason, 'stop_sequence', 'stop_reason');
});

Deno.test('stop_sequences 集成：未命中时保持上游的 stop_reason', async () => {
  const { response } = await viaDeepSeek({ stop_sequences: ['9'] }, '1 2 3 4 5');

  assertEquals(joinText(response.content), '1 2 3 4 5', '内容不变');
  assertEquals(response.stop_reason, 'end_turn', '未命中不改判');
  assertEquals(response.stop_sequence, undefined, '未命中不带 stop_sequence');
});

Deno.test('stop_sequences 集成：没有 stop_sequences 的请求完全不受影响', async () => {
  const { response, sent } = await viaDeepSeek({}, '1 2 3 4 5');

  assertEquals(joinText(response.content), '1 2 3 4 5', '内容不变');
  assertEquals(response.stop_reason, 'end_turn', 'stop_reason 不变');
  assertEquals(sent.stop_sequences, undefined, '本来就没有');
});

// ── Sider 通道 ──────────────────────────────────────────────────────────────
//
// Sider 端完全不支持 stop_sequences（实测 "1 2 3 4 5" 原样输出）。截断同样在
// 本服务层做，两条通道行为必须一致——同一个 API 因为路由到哪个后端而给出不同的
// stop_reason，是调用方最难排查的一类不一致。

import { convertSiderToAnthropic } from '../src/utils/response-converter.ts';

function siderResponse(text: string) {
  return {
    textParts: [text],
    reasoningParts: [] as string[],
    conversationId: undefined,
    messageIds: undefined,
  } as unknown as Parameters<typeof convertSiderToAnthropic>[0];
}

Deno.test('stop_sequences 集成：Sider 通道命中后同样报 stop_sequence', () => {
  const response = convertSiderToAnthropic(
    siderResponse('1 2 3 4 5'),
    'claude-haiku-4.5',
    { stopSequences: ['3'] },
  );

  assertEquals(joinText(response.content), '1 2 ', '正文被截断');
  assertEquals(response.stop_reason, 'stop_sequence', 'stop_reason');
  assertEquals(response.stop_sequence, '3', 'stop_sequence');
});

Deno.test('stop_sequences 集成：Sider 通道未命中时保持 end_turn', () => {
  const response = convertSiderToAnthropic(
    siderResponse('1 2 3 4 5'),
    'claude-haiku-4.5',
    { stopSequences: ['9'] },
  );

  assertEquals(joinText(response.content), '1 2 3 4 5', '内容不变');
  assertEquals(response.stop_reason, 'end_turn', 'stop_reason');
});

Deno.test('stop_sequences 集成：Sider 通道不传 stopSequences 时行为不变', () => {
  const response = convertSiderToAnthropic(siderResponse('1 2 3 4 5'), 'claude-haiku-4.5');

  assertEquals(joinText(response.content), '1 2 3 4 5', '内容不变');
  assertEquals(response.stop_reason, 'end_turn', 'stop_reason');
});
