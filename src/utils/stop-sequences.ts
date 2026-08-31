/**
 * `stop_sequences` 的服务端实现，两条通道共用。
 *
 * 为什么不交给上游：
 *
 * - **DeepSeek 端**（实为 `glm-5.3-flash`）会把截断作用在 thinking 上。probe 实测
 *   `stop_sequences:["3"]` 让它在推理里撞到 "3" 就整个停下，返回
 *   `content=[thinking]`、正文一个字都没有。常见字符几乎必然出现在推理过程里，
 *   等于「用了 stop_sequences 就大概率拿到空响应」。它还把命中报成
 *   `stop_reason:"end_turn"`、`stop_sequence:null`，两处都不符合 Anthropic 规范。
 * - **Sider 端**完全不支持，序列原样输出。
 *
 * 放在这一层做，两条通道行为一致、符合规范，且 thinking 不再被误伤。
 * 见 deno/tools/probe-upstream-stop-sequences.ts 的实测记录。
 */

import type { AnthropicResponseContent } from '../types/anthropic';

export interface StopSequenceResult {
  content: AnthropicResponseContent[];
  /** 命中的序列；未命中为 undefined。调用方据此决定 `stop_reason`。 */
  matched?: string;
}

/**
 * 在**正文 text 块**上执行截断。
 *
 * 刻意只处理 text：
 * - `thinking` 是模型的内部推理，不是给用户的输出，截它正是上游犯的错；
 * - `tool_use` 是结构化调用而非自然语言，一个恰好出现在命令里的字符不该把它切掉。
 *
 * 匹配跨 text 块进行——上游按 token 切块，一个序列很可能被劈在两块之间。
 */
export function applyStopSequences(
  content: AnthropicResponseContent[],
  stopSequences: string[] | undefined,
): StopSequenceResult {
  const sequences = (stopSequences ?? []).filter((s) => typeof s === 'string' && s.length > 0);
  if (sequences.length === 0) {
    return { content };
  }

  // 先把正文拼起来找命中点：序列可能跨块，逐块独立匹配会漏。
  const joined = content
    .filter((block) => block.type === 'text')
    .map((block) => (block as { text: string }).text ?? '')
    .join('');

  let cutAt = -1;
  let matched: string | undefined;
  for (const sequence of sequences) {
    const index = joined.indexOf(sequence);
    // 取**最早出现**的位置，而不是声明顺序里的第一个：
    // 声明 ['5','4'] 而文本是 "…4…5…" 时，按声明顺序会截得太靠后。
    if (index !== -1 && (cutAt === -1 || index < cutAt)) {
      cutAt = index;
      matched = sequence;
    }
  }

  if (cutAt === -1) {
    return { content };
  }

  // 把截断点换算回各个 text 块。命中之后的正文全部丢弃，
  // 非 text 块原样保留（thinking 已在上面说明，tool_use 同理）。
  const result: AnthropicResponseContent[] = [];
  let consumed = 0;
  let done = false;

  for (const block of content) {
    if (block.type !== 'text') {
      result.push(block);
      continue;
    }
    if (done) {
      continue;
    }

    const value = (block as { text: string }).text ?? '';
    const blockEnd = consumed + value.length;

    if (blockEnd <= cutAt) {
      result.push(block);
      consumed = blockEnd;
      continue;
    }

    // 截断点落在这一块里
    const truncated = value.slice(0, cutAt - consumed);
    // 截断点正好压在块边界时 `truncated` 是空串。这种空块没有信息量，丢掉；
    // 但如果丢完一个 text 块都不剩，就留下这个空块——客户端普遍假设
    // 助手回合至少有一个 text 块，突然少一个比拿到空字符串更容易踩空。
    if (truncated.length > 0 || !result.some((b) => b.type === 'text')) {
      result.push({ type: 'text', text: truncated });
    }
    consumed = blockEnd;
    done = true;
  }

  return { content: result, ...(matched !== undefined ? { matched } : {}) };
}
