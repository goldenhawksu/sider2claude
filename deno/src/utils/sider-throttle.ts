/**
 * Sider 自适应限流器（`SIDER_STRATEGY=pro` 与 `max` 时生效）。
 *
 * 与 `sider-availability.ts` 的关系：那个是保守策略下的固定两档冷却熔断，本模块
 * 是激进策略下的替代品。两者互斥，由 `RoutingConfig.siderStrategy` 选择。
 *
 * 为什么要换掉固定冷却：Sider 是包年订阅，额度**持续回血**。「一次 1135 就锁死
 * 该模型一小时」是全有全无的——冷却期内额度在回血却一个请求都不发，等于把
 * 白撞一次的代价换成了浪费整个窗口的额度。目标既然是「用足额度」，就必须持续
 * 试探而不是整段退避。
 *
 * 于是三个维度各自独立收敛，思路取自 TCP 拥塞控制的 AIMD（加性增、乘性减）：
 *
 * 1. **频次**：令牌桶。撞到 1135 就乘性降速并清空令牌，持续成功则加性升速。
 *    速率会在上游真实容量附近微振荡——这就是「动态碰撞」，比任何静态值都准，
 *    因为它测的是此刻的真实额度，不是某次 probe 时的快照。
 * 2. **体量**：从 603 的实测反馈学习上限。收到 603 说明「这个长度确实不行」，
 *    直接降到失败点以下；只有在上限附近仍然成功，才敢往上探。
 * 3. **配额耗尽**：只有速率已降到底仍连续 1135（额度真的用完，如 opus 的小时级
 *    窗口）才短暂停投，且用指数退避 + half-open 探测自己摸出恢复时刻，
 *    而不是预设一个「反正 opus 就是一小时」的经验值。
 *
 * 全部按模型独立：实测同一时刻 sonnet-5 可用而 opus-4.8 已耗尽，一刀切会误伤
 * 还有额度的模型。
 *
 * 模块级全局状态，与 `sider-availability.ts` 同一惯例：任何会真的改动状态的测试
 * 都必须在 finally 里调 `resetSiderThrottle()`，否则会顺着文件执行顺序泄漏给后续
 * 测试，制造顺序相关的偶发失败。
 */

/** 频次：初始速率取 probe 实测（约 6 次/分）的 2 倍，主动上探而非保守起步。 */
const INITIAL_RATE_PER_MIN = 12;
const RATE_MIN_PER_MIN = 1;
const RATE_MAX_PER_MIN = 30;
/** 乘性减：撞限后立刻退到 60%。 */
const RATE_DOWN_FACTOR = 0.6;
/** 加性增：连续这么多次成功才敢升速，避免刚降下来就被单次成功顶回去。 */
const RATE_UP_STREAK = 8;
const RATE_UP_FACTOR = 1.2;

/** 体量：probe 实测 32K 通过、44K 被 603 拒，取 40K 起步。 */
const INITIAL_MAX_CHARS = 40_000;
const MAX_CHARS_FLOOR = 2_000;
const MAX_CHARS_CEIL = 60_000;
/** 收到 603 时退到失败载荷的 85%，留出余量。 */
const OVERSIZE_DOWN_FACTOR = 0.85;
/** 只有载荷已接近上限却仍成功，才说明上限估低了，可以上探。 */
const MAX_CHARS_UP_THRESHOLD = 0.9;
const MAX_CHARS_UP_FACTOR = 1.1;

/** 熔断：速率降到底仍连续这么多次 1135，才判定额度真的耗尽。 */
const QUOTA_STREAK_TO_OPEN = 3;
const BACKOFF_BASE_MS = 30_000;
/** opus 档配额是小时/天级窗口，退避封顶给到 1 小时；其余档约 1 分钟回血，封顶 5 分钟。 */
const BACKOFF_CAP_OPUS_MS = 60 * 60_000;
const BACKOFF_CAP_DEFAULT_MS = 5 * 60_000;

/**
 * 持久性拒绝：连续这么多次同类业务错误码（非 1135 / 603）才暂停投递。
 *
 * 为什么需要这条通道：1135 是「额度用完了，等会儿再来」，603 是「这次太大了」，
 * 两者都假设**换个时机或换个载荷就能成功**。但实测存在第三类失败——某个模型在
 * Sider 侧根本接不了（`claude-fable-5` 恒返回 707，三次复现无一成功）。这类失败
 * 与时机、载荷都无关，上面两个维度学不到任何东西，于是每个请求都要白撞一次
 * Sider 再 fallback，纯属浪费一次往返。
 *
 * 判据保守到三条闸，因为误判的代价是「本来能用的模型被停投」：
 * 1. 只认**明确的上游业务错误码**（siderCode ≠ 0），网络抖动/超时不算；
 * 2. 要**连续** 3 次，中间任何一次成功即清零；
 * 3. 停投可恢复——走与 1135 相同的 half-open 探测，模型恢复了会自己解除。
 *
 * 退避起步比 1135 长（5 分钟 vs 30 秒）：额度是持续回血的，值得频繁试探；
 * 而「模型不支持」通常要等上游改配置，试探太密没有意义。
 */
const REJECT_STREAK_TO_OPEN = 3;
const REJECT_BACKOFF_BASE_MS = 5 * 60_000;

interface ModelThrottleState {
  /** 令牌桶当前速率（次/分），桶容量等于速率（允许 1 分钟的突发）。 */
  rate: number;
  tokens: number;
  lastRefill: number;
  successStreak: number;
  /** 当前认为安全的单次载荷字符上限。 */
  maxChars: number;
  /** 连续 1135 次数，中间任何一次成功即清零。 */
  quotaStreak: number;
  /** 连续非 1135/603 业务错误码次数，中间任何一次成功即清零。 */
  rejectStreak: number;
  /** 熔断到期时刻；0 表示未熔断。 */
  openUntil: number;
  /** 下一次熔断的退避时长。 */
  backoffMs: number;
  /** half-open 已放行探测请求，结果未回来前不再放行第二个。 */
  probeInFlight: boolean;
  lastQuotaAt: number;
  lastOversizeAt: number;
  /** 最近一次持久性拒绝的时刻与错误码；0 表示从未。 */
  lastRejectAt: number;
  lastRejectCode: number;
}

const states = new Map<string, ModelThrottleState>();

/** opus 档识别。对外模型名与 Sider 侧名在 opus 上一致，用名字判断即可。 */
function isOpusTier(model: string): boolean {
  return /opus/i.test(model);
}

function stateFor(model: string, now: number): ModelThrottleState {
  let state = states.get(model);
  if (!state) {
    state = {
      rate: INITIAL_RATE_PER_MIN,
      tokens: INITIAL_RATE_PER_MIN,
      lastRefill: now,
      successStreak: 0,
      maxChars: INITIAL_MAX_CHARS,
      quotaStreak: 0,
      rejectStreak: 0,
      openUntil: 0,
      backoffMs: BACKOFF_BASE_MS,
      probeInFlight: false,
      lastQuotaAt: 0,
      lastOversizeAt: 0,
      lastRejectAt: 0,
      lastRejectCode: 0,
    };
    states.set(model, state);
  }
  return state;
}

function refill(state: ModelThrottleState, now: number): void {
  const elapsed = now - state.lastRefill;
  if (elapsed <= 0) {
    return;
  }
  state.tokens = Math.min(state.rate, state.tokens + (elapsed / 60_000) * state.rate);
  state.lastRefill = now;
}

export type SiderThrottleVerdict = { ok: true } | { ok: false; why: string };

/**
 * Sider 现在能不能接这个请求。**只读判断，不消耗令牌**。
 *
 * 检查与消耗必须分开：路由引擎在规则匹配的最开始就要知道 Sider 可不可用，
 * 但那一刻还不知道最终会不会真的投给 Sider（工具规则可能后续覆盖决策）。
 * 若在这里就扣令牌，每个走 DeepSeek 的工具请求都会白扣一次 Sider 额度。
 */
export function canUseSider(
  model: string,
  estimatedChars: number,
  now = Date.now(),
): SiderThrottleVerdict {
  const state = stateFor(model, now);

  if (state.openUntil > now) {
    const seconds = Math.ceil((state.openUntil - now) / 1000);
    return { ok: false, why: `Sider quota exhausted for ${model} (retry in ${seconds}s)` };
  }

  // 熔断已到期 = half-open：放行一个探测请求去碰一下，但同一时刻只放一个。
  if (state.openUntil > 0) {
    if (state.probeInFlight) {
      return { ok: false, why: `Sider quota probe already in flight for ${model}` };
    }
    return { ok: true };
  }

  if (estimatedChars > state.maxChars) {
    return {
      ok: false,
      why: `Input ${estimatedChars} chars exceeds learned Sider limit ${state.maxChars}`,
    };
  }

  refill(state, now);
  if (state.tokens < 1) {
    return {
      ok: false,
      why: `Sider rate budget spent for ${model} (${state.rate.toFixed(1)}/min)`,
    };
  }

  return { ok: true };
}

/**
 * 决策确定投给 Sider 后调用，扣掉一个令牌。
 * 与 `canUseSider` 成对使用——只有这里会改动令牌桶。
 */
export function consumeSiderSlot(model: string, now = Date.now()): void {
  const state = stateFor(model, now);

  // half-open 放行的探测不扣令牌：此刻桶里本来就没有可用额度，
  // 扣了会变成负数，探测成功后还要额外补回来。
  if (state.openUntil > 0) {
    state.probeInFlight = true;
    return;
  }

  refill(state, now);
  state.tokens = Math.max(0, state.tokens - 1);
}

/** Sider 调用成功。`payloadChars` 是本次实际发出的载荷长度，用于体量上探。 */
export function recordSiderSuccess(
  model: string,
  payloadChars: number,
  now = Date.now(),
): void {
  const state = stateFor(model, now);

  // 探测成功 = 上游恢复了（额度回血，或那个模型重新可用），解除熔断并把退避重置，
  // 下次撞限重新从基础值起步。
  state.openUntil = 0;
  state.probeInFlight = false;
  state.backoffMs = BACKOFF_BASE_MS;
  state.quotaStreak = 0;
  state.rejectStreak = 0;

  state.successStreak += 1;
  if (state.successStreak >= RATE_UP_STREAK) {
    state.successStreak = 0;
    state.rate = Math.min(RATE_MAX_PER_MIN, state.rate * RATE_UP_FACTOR);
  }

  // 只有在上限附近还能成功，才说明上限估低了。载荷远小于上限的成功不构成证据。
  if (payloadChars >= state.maxChars * MAX_CHARS_UP_THRESHOLD) {
    state.maxChars = Math.min(MAX_CHARS_CEIL, Math.floor(state.maxChars * MAX_CHARS_UP_FACTOR));
  }
}

/**
 * Sider 返回 1135（用量超限）。乘性降速；只有连续多次才升级为熔断。
 */
export function recordSiderQuotaExhausted(model: string, now = Date.now()): void {
  const state = stateFor(model, now);

  state.lastQuotaAt = now;
  state.successStreak = 0;
  state.quotaStreak += 1;
  state.rate = Math.max(RATE_MIN_PER_MIN, state.rate * RATE_DOWN_FACTOR);
  state.tokens = 0;

  // 探测又撞限：额度还没回来，退避翻倍再等。
  if (state.probeInFlight) {
    state.probeInFlight = false;
    state.backoffMs = Math.min(backoffCap(model), state.backoffMs * 2);
    state.openUntil = now + state.backoffMs;
    return;
  }

  if (state.quotaStreak >= QUOTA_STREAK_TO_OPEN) {
    state.openUntil = now + state.backoffMs;
  }
}

/**
 * Sider 返回 603（单请求体量超限）。这是最硬的实测证据：这个长度确实不行，
 * 直接把上限降到失败点以下，不必等多次采样。
 */
export function recordSiderOversize(
  model: string,
  payloadChars: number,
  now = Date.now(),
): void {
  const state = stateFor(model, now);
  state.lastOversizeAt = now;
  state.maxChars = Math.max(
    MAX_CHARS_FLOOR,
    Math.floor(payloadChars * OVERSIZE_DOWN_FACTOR),
  );
}

function backoffCap(model: string): number {
  return isOpusTier(model) ? BACKOFF_CAP_OPUS_MS : BACKOFF_CAP_DEFAULT_MS;
}

/**
 * Sider 返回 1135 / 603 之外的业务错误码（如 707「该模型不可用」）。
 *
 * 与另外两个维度的区别：那两个学的是「什么时候投」和「投多大」，本维度学的是
 * 「这个模型现在还值不值得投」。因此它不动速率、不动体量上限——那两个参数在
 * 模型压根接不了的情况下调多少都没用——只在连续失败到阈值时直接暂停投递。
 *
 * 复用 1135 的 `openUntil` / `probeInFlight` / `backoffMs`：两者要表达的都是
 * 「暂停一段时间，到期放一个探测自己摸恢复」，没必要为此再造一套退避状态机。
 * 只有连续计数是独立的，避免两类失败互相污染对方的阈值。
 */
export function recordSiderRejection(
  model: string,
  siderCode: number,
  now = Date.now(),
): void {
  const state = stateFor(model, now);

  state.lastRejectAt = now;
  state.lastRejectCode = siderCode;
  state.successStreak = 0;
  state.rejectStreak += 1;

  // 探测又被拒：上游还没恢复，退避翻倍再等。
  if (state.probeInFlight) {
    state.probeInFlight = false;
    state.backoffMs = Math.min(backoffCap(model), state.backoffMs * 2);
    state.openUntil = now + state.backoffMs;
    return;
  }

  if (state.rejectStreak >= REJECT_STREAK_TO_OPEN) {
    // 起步至少 5 分钟：这类失败不像额度那样持续回血，试探太密没有意义。
    const backoff = Math.max(state.backoffMs, REJECT_BACKOFF_BASE_MS);
    state.backoffMs = Math.min(backoffCap(model), backoff);
    state.openUntil = now + state.backoffMs;
  }
}

/** 看板用的一行状态。 */
export interface SiderThrottleStat {
  model: string;
  /** 当前令牌桶速率（次/分）。 */
  ratePerMin: number;
  /** 当前学到的载荷字符上限。 */
  maxChars: number;
  /** 熔断剩余毫秒；0 表示可用。 */
  cooldownMs: number;
  /** 最近一次 1135 时刻（毫秒时间戳）；0 表示从未。 */
  lastQuotaAt: number;
  /** 最近一次 603 时刻（毫秒时间戳）；0 表示从未。 */
  lastOversizeAt: number;
  /** 最近一次持久性拒绝的时刻与错误码；0 表示从未。 */
  lastRejectAt: number;
  lastRejectCode: number;
}

/**
 * 当前实例的限流状态快照，按「先熔断、再低速」排序，让需要关注的排在前面。
 *
 * 这是**进程内实时状态**，不进 KV：令牌桶余量按实例累加毫无意义，
 * 跨实例覆盖写也只会让看板在不同实例的状态间跳动。
 */
export function getSiderThrottleSnapshot(now = Date.now()): SiderThrottleStat[] {
  return [...states.entries()]
    .map(([model, state]) => ({
      model,
      ratePerMin: Math.round(state.rate * 10) / 10,
      maxChars: state.maxChars,
      cooldownMs: state.openUntil > now ? state.openUntil - now : 0,
      lastQuotaAt: state.lastQuotaAt,
      lastOversizeAt: state.lastOversizeAt,
      lastRejectAt: state.lastRejectAt,
      lastRejectCode: state.lastRejectCode,
    }))
    .sort((a, b) => b.cooldownMs - a.cooldownMs || a.ratePerMin - b.ratePerMin);
}

/** 仅供测试使用。 */
export function resetSiderThrottle(): void {
  states.clear();
}
