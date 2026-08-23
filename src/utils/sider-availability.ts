/**
 * Sider 按模型的可用性熔断。
 *
 * 背景（实测数据，不是猜测）：Sider 用 `code 1135` 表达用量超限，且**每个模型
 * 各有一份独立额度**。同一时刻实测到 sonnet-5 可用、opus-4.8 已耗尽的并存状态，
 * 因此熔断必须按模型分开，不能一刀切。
 *
 * 两档冷却时长，来源也是实测：
 * - opus 档：单窗口只有 2~3 次，等 200 秒仍未恢复，属小时/天级窗口。取 1 小时——
 *   若实际是天级，一天也只白撞 24 次，可忽略；若是小时级则能及时恢复。
 * - 其余（sonnet / haiku 等）：约 6 次/分钟，约 1 分钟回血，与上游提示
 *   "try again after 1 minutes" 一致，取 60 秒。
 *
 * 熔断期间路由直接改投 DeepSeek。这不是为了"更快失败"，而是**每撞一次都是一个
 * 白费的往返**：请求发出去、等回来、拿到 1135、再 fallback，用户多等几百毫秒，
 * 且什么也换不回来。
 *
 * 熔断只影响"要不要主动选 Sider"，不影响既有 fallback 机制——Sider 真失败时
 * 该兜底还是兜底。
 */

/** opus 档配额是小时/天级窗口，短冷却没有意义。 */
const OPUS_COOLDOWN_MS = 60 * 60_000;
/** 其余模型按上游自己的提示：约 1 分钟。 */
const DEFAULT_COOLDOWN_MS = 60_000;

/** 模型名 -> 冷却截止时刻。条目数等于用过的模型数，天然有界。 */
const cooldownUntil = new Map<string, number>();

/** opus 档识别。对外模型名与 Sider 侧名在 opus 上一致，用名字判断即可。 */
function isOpusTier(model: string): boolean {
  return /opus/i.test(model);
}

export function siderCooldownMsFor(model: string): number {
  return isOpusTier(model) ? OPUS_COOLDOWN_MS : DEFAULT_COOLDOWN_MS;
}

/**
 * 记录一次 Sider 用量超限。只有 1135 该调用本函数——其余错误码是上游故障，
 * 不代表额度耗尽，熔断它们会把偶发抖动放大成长时间不可用。
 */
export function recordSiderQuotaExhausted(model: string, now = Date.now()): void {
  cooldownUntil.set(model, now + siderCooldownMsFor(model));
}

/** 该模型当前是否处于熔断期。 */
export function isSiderCooling(model: string, now = Date.now()): boolean {
  const until = cooldownUntil.get(model);
  if (until === undefined) {
    return false;
  }
  if (now >= until) {
    cooldownUntil.delete(model); // 顺手回收，避免长跑累积条目
    return false;
  }
  return true;
}

/** 剩余熔断时长（毫秒）；未熔断返回 0。仅用于日志与看板展示。 */
export function siderCooldownRemainingMs(model: string, now = Date.now()): number {
  const until = cooldownUntil.get(model);
  return until && until > now ? until - now : 0;
}

/** 仅供测试使用。 */
export function resetSiderAvailability(): void {
  cooldownUntil.clear();
}
