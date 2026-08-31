/**
 * 上游能力学习。
 *
 * `DEEPSEEK_BASE_URL` 可以指向任意 Anthropic 兼容端——今天是 Z.AI 的
 * `glm-5.3-flash`，明天可能换回 DeepSeek 官方的 `deepseek-v4-flash`。两家行为并不
 * 一致：实测 GLM 完全忽略 `tool_choice`，而 CLAUDE.md 记录 DeepSeek 曾对
 * `{type:'tool'}` 直接 400。把任何一家的怪癖硬编码进主路径，换一家就会出错。
 *
 * 所以差异在这里**从响应里学**，不靠 provider 名字猜、也不要用户配开关。
 *
 * 目前只学一件事：**这个上游会不会让 thinking 吃光小 `max_tokens` 预算**。
 * 这是 GLM 的实测缺陷（probe 见 deno/tools/probe-upstream-max-tokens.ts：
 * `max_tokens=256` 时预算全被推理吃光，返回 `content=[thinking]`、正文 0 字、
 * `stop_reason=max_tokens`——调用方拿到一个「成功但没有内容」的响应）。
 * 换个上游可能压根不存在这个问题：
 *
 * - 无条件注入 `thinking:{type:'disabled'}` → 白白关掉健康上游的推理能力；
 * - 无条件不注入 → GLM 用户继续拿空响应。
 *
 * 判据取自响应本身，因此对两家都成立。
 *
 * 模块级全局状态，与 `sider-throttle.ts` 同惯例：会改动状态的测试必须在 finally
 * 里调 `resetUpstreamCapabilities()`，否则会顺着文件执行顺序泄漏给后续测试。
 */

import type { AnthropicResponse } from '../types/anthropic';

/**
 * 已知失败点的安全余量。
 *
 * 观察到 `max_tokens=256` 会被 thinking 吃光，就对 512 以内的请求都注入
 * `disabled`——推理长度本身有波动，只在恰好等于失败点时才处理会漏掉一大片。
 * 取 2 倍而不是更大：再往上 thinking 的价值开始超过风险，且若 2 倍仍失败，
 * 下一次观察会把失败点抬高，阈值自然收敛到这个上游的真实水位。
 */
const BUDGET_SAFETY_FACTOR = 2;

interface UpstreamCapability {
  /** 观察到的最大「被 thinking 吃光」预算；0 表示从未观察到。 */
  observedFailureBudget: number;
  /** 上游明确拒绝 `thinking:{type:'disabled'}`。终态，不再尝试。 */
  rejectsThinkingDisabled: boolean;
}

const capabilities = new Map<string, UpstreamCapability>();

/** 能力按 `baseUrl::model` 隔离——同一家的不同模型也可能行为不同。 */
export function upstreamKey(baseUrl: string, model: string): string {
  return `${baseUrl}::${model}`;
}

function stateFor(key: string): UpstreamCapability {
  let state = capabilities.get(key);
  if (!state) {
    state = { observedFailureBudget: 0, rejectsThinkingDisabled: false };
    capabilities.set(key, state);
  }
  return state;
}

/**
 * 这个响应是不是「thinking 吃光了预算」。
 *
 * 三个条件缺一不可：
 * - `stop_reason === 'max_tokens'`：确实是撞上限停的；
 * - 有 thinking 块：预算被推理占用了；
 * - 正文为空：调用方什么都没拿到。
 *
 * 有正文就不算——那说明预算够用，截断是规范的 `max_tokens` 行为；
 * 没有 thinking 也不算——纯文本被截断同样是规范行为，不该归到这个缺陷。
 */
export function thinkingAteBudget(response: AnthropicResponse): boolean {
  if (response.stop_reason !== 'max_tokens') {
    return false;
  }

  const blocks = response.content ?? [];
  const hasThinking = blocks.some(
    (block) => block.type === 'thinking' || block.type === 'redacted_thinking',
  );
  if (!hasThinking) {
    return false;
  }

  const text = blocks
    .filter((block) => block.type === 'text')
    .map((block) => (block as { text?: string }).text ?? '')
    .join('')
    .trim();

  return text.length === 0;
}

/** 记下一次实测失败。失败点只增不减，避免阈值来回抖动。 */
export function noteThinkingAteBudget(key: string, maxTokens: number): void {
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    return;
  }
  const state = stateFor(key);
  state.observedFailureBudget = Math.max(state.observedFailureBudget, maxTokens);
}

/**
 * 上游拒绝了 `thinking:{type:'disabled'}`。
 *
 * 记成终态：继续发只会把这个上游的每个小预算请求都变成一次 400，
 * 比拿到一个空响应更糟。
 */
export function noteThinkingDisabledRejected(key: string): void {
  stateFor(key).rejectsThinkingDisabled = true;
}

/**
 * 上游是否已明确拒绝过 `thinking:{type:'disabled'}`。
 *
 * 重试路径要单独查这个：`shouldDisableThinking` 拿到 false 只说明「这一轮不注入」，
 * 分不清是「还没学到」还是「学到了但上游不认」。前者该重试，后者重试只会再吃一个 400。
 */
export function thinkingDisableRejected(key: string): boolean {
  return capabilities.get(key)?.rejectsThinkingDisabled ?? false;
}

/** 这一轮要不要主动关掉上游 thinking。没有实测证据时一律不关。 */export function shouldDisableThinking(key: string, maxTokens: number | undefined): boolean {
  if (typeof maxTokens !== 'number' || maxTokens <= 0) {
    return false;
  }
  const state = capabilities.get(key);
  if (!state || state.rejectsThinkingDisabled || state.observedFailureBudget === 0) {
    return false;
  }
  return maxTokens <= state.observedFailureBudget * BUDGET_SAFETY_FACTOR;
}

/** 仅供测试使用。 */
export function resetUpstreamCapabilities(): void {
  capabilities.clear();
}
