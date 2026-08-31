/**
 * 进程内用量统计。
 *
 * 回答三个问题：最近的调用由谁完成（sider 还是 deepseek）、比例是多少、
 * 工具被调用的频次。数据取自每个请求的完成点，不接触消息内容。
 *
 * 边界（诚实声明，不是缺陷）：
 * - 统计是进程内的，实例重启清零；Deno Deploy 的每个隔离实例各自独立，
 *   快照只代表处理过该请求的那个实例。
 * - 无持久化是有意的：这是观测便利，不是计费依据。
 */

import type { Backend, SiderStrategy } from '../config/backends';
import { getSiderThrottleSnapshot, type SiderThrottleStat } from './sider-throttle';
import type { SiderHealthStat } from './sider-telemetry';
import { currentEffectiveSiderStrategy } from '../config/backends';

/** 最近明细的保留上限；内存占用很小（每条约 200 字节）。 */
const RECENT_LIMIT = 200;
/** 对外展示的最近条数；足够看清趋势，又不至于刷屏。 */
const RECENT_DISPLAY = 10;
/** 滑动窗口聚合的跨度。 */
const WINDOW_MS = 60 * 60_000;
/** 趋势图的分桶跨度与桶数（24 个小时桶 = 近 24 小时）。 */
const BUCKET_MS = 60 * 60_000;
const BUCKET_COUNT = 24;

/**
 * 一次请求落到 DeepSeek 的原因。
 *
 * 存在的意义：用户配了 Sider 却发现 DeepSeek 被大量使用时，需要知道到底是
 * "Claude Code 带了工具，本来就该走 DeepSeek"，还是"Sider 上游受限被迫兜底"。
 * 前者是设计如此，后者才说明 Sider 配额/可用性出了问题。
 */
export type DeepSeekReason =
  /** 请求含 Claude Code 内置工具 / MCP 工具，或延续上一个工具回合。 */
  | 'tools'
  /** 路由初判是 Sider，调用失败后兜底到 DeepSeek。 */
  | 'fallback'
  /** 其余路由策略主动选择 DeepSeek（长文本生成、默认后端等）。 */
  | 'routing';

/** DeepSeek 归因 -> 计数字段名。三个计数之和恒等于 deepseek 总数。 */
const REASON_FIELD = {
  tools: 'deepseekTools',
  fallback: 'deepseekFallback',
  routing: 'deepseekRouting',
} as const;

/**
 * 由能力短板（而非偏好）把请求推给 DeepSeek 的规则。
 *
 * `rule_1_tool_result_continuity` 计入工具类：它只在 `tool_result` 回合触发，
 * 本质是上一个工具回合的延续。理论上"长文本路由到 DeepSeek 后又续了一轮"
 * 会被算进工具类，但那要求同一会话先长文本、后 tool_result，实践中不出现。
 */
const TOOL_CAPABILITY_RULES = new Set([
  'rule_1_tool_result_continuity',
  'rule_2_claude_tools',
  'rule_3_mcp_tools',
]);

/**
 * 判定本次请求走 DeepSeek 的原因；Sider 完成的请求返回 undefined。
 *
 * 放在统计模块而非路由模块：这是观测语义（怎么归类给用户看），
 * 路由本身不需要知道自己会被怎么统计。
 */
export function classifyDeepSeekReason(
  selectedBackend: Backend,
  decidedBackend: Backend,
  ruleId: string,
): DeepSeekReason | undefined {
  if (selectedBackend !== 'deepseek') return undefined;
  // 路由初判是 Sider 却由 DeepSeek 完成 = Sider 失败后兜底
  if (selectedBackend !== decidedBackend) return 'fallback';
  return TOOL_CAPABILITY_RULES.has(ruleId) ? 'tools' : 'routing';
}

export interface UsageRecord {
  model: string;
  backend: Backend;
  /** 实际后端与路由初判不同 = 发生过 fallback。 */
  fallback: boolean;
  /** 走 DeepSeek 的原因；backend 为 sider 时应为 undefined。 */
  deepseekReason?: DeepSeekReason | undefined;
  /** 本次响应中真实发生的 tool_use 块的工具名。 */
  toolUses: string[];
  stream: boolean;
  ms: number;
  /** 上游返回的 token 用量；流式路径拿不到时按 0 计。 */
  inputTokens: number;
  outputTokens: number;
  /**
   * 上游 prompt 缓存计数。**`inputTokens` 是未命中的余量，不含这两项**——
   * DeepSeek 命中时 input_tokens 会小到只剩新增内容。分开记才算得出成本：
   * 未命中价是命中价的 31 倍。上游不上报时按 0 计。
   */
  cacheReadTokens?: number | undefined;
  cacheCreationTokens?: number | undefined;
}

interface RecentEntry {
  at: number;
  record: UsageRecord;
}

/** 按模型聚合的一行，供看板表格与环形图使用。 */
export interface ModelStat {
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  sider: number;
  deepseek: number;
  /** DeepSeek 承接来源拆分；三者之和恒等于 deepseek。 */
  deepseekTools: number;
  deepseekFallback: number;
  deepseekRouting: number;
}

/** 趋势图的一个时间桶。 */
export interface TrendBucket {
  /** 桶起始时刻（ISO）。 */
  at: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  sider: number;
  deepseek: number;
}

export interface UsageSnapshot {
  since: string;
  totals: {
    requests: number;
    sider: number;
    deepseek: number;
    fallbacks: number;
    streaming: number;
    toolCalls: number;
    /** 命中重复响应缓存、未触达上游的请求数（不计入上面的 requests）。 */
    cachedReplays: number;
    inputTokens: number;
    outputTokens: number;
    /** 上游 prompt 缓存计数；未命中的余量在 inputTokens 里。 */
    cacheReadTokens: number;
    cacheCreationTokens: number;
    /** cacheRead / (inputTokens + cacheRead + cacheCreation)，无 prompt token 时为 0.0%。 */
    cacheHitRate: string;
    /** DeepSeek 承接来源拆分；三者之和恒等于 deepseek。 */
    deepseekTools: number;
    deepseekFallback: number;
    deepseekRouting: number;
  };
  /** 后端占比（分母为非零请求；无请求时两个都是 0%）。 */
  backendShare: { sider: string; deepseek: string };
  /** 最近 1 小时内同样口径的聚合；窗口内无请求时各项为 0。 */
  lastHour: {
    requests: number;
    sider: number;
    deepseek: number;
    fallbacks: number;
  };
  /** 按模型聚合，按请求数降序。 */
  models: ModelStat[];
  /** 近 24 小时按小时分桶，旧→新；无数据的桶也保留，保证时间轴连续。 */
  trend: TrendBucket[];
  /** 工具调用频次 Top 8，按次数降序。 */
  tools: Array<{ name: string; count: number }>;
  /**
   * Sider 自适应限流器的当前状态（`SIDER_STRATEGY=pro` / `max` 才有内容）。
   *
   * 这是**进程内实时状态**而非累计计数，因此不进 KV：令牌桶余量按实例累加
   * 毫无意义，跨实例覆盖写也只会让看板在不同实例的状态之间跳动。
   */
  siderThrottle: SiderThrottleStat[];
  /**
   * 近期 Sider 实测表现，按模型聚合（跨实例，来自 KV 遥测）。
   *
   * Node/Bun 侧无 Deno KV，恒为空数组；看板会退化为只显示进程内限流状态。
   * 字段保留是为了让 `stats-page.ts` 两侧保持一致。
   */
  siderHealth: SiderHealthStat[];
  /** 最近请求（新在前）。不含任何消息内容或 token。 */
  recent: Array<{
    time: string;
    model: string;
    backend: Backend;
    fallback: boolean;
    /** 走 DeepSeek 的原因；Sider 请求为 null。 */
    reason: DeepSeekReason | null;
    tools: string[];
    stream: boolean;
    ms: number;
    tokens: number;
  }>;
  /** 开服以来累计请求数，仅供页脚做一行对照。 */
  lifetimeRequests: number;
  /** 当前生效的 Sider 调度策略（供页面策略控件高亮当前项）。 */
  siderStrategy: SiderStrategy;
  note: string;
  /** 聚合数据是否来自持久层；Node 运行时无 Deno KV，恒为 false。 */
  persisted: boolean;
}

const startedAt = Date.now();
const emptyTotals = () => ({
  requests: 0,
  sider: 0,
  deepseek: 0,
  fallbacks: 0,
  streaming: 0,
  toolCalls: 0,
  cachedReplays: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  deepseekTools: 0,
  deepseekFallback: 0,
  deepseekRouting: 0,
});
let totals = emptyTotals();
const toolCounts = new Map<string, number>();
const recent: RecentEntry[] = [];

/**
 * 按小时桶的累计。**必须与 recent 分开维护**：recent 有 200 条上限，
 * 用它算趋势会让早期桶被静默截断——而且失真是单向的（越早掉得越狠），
 * 图会长成"什么都刚刚发生"的假曲棍球棒，形状比绝对值先坏掉。
 * 这里按桶独立累计，与请求量无关。
 */
const trendBuckets = new Map<number, Omit<TrendBucket, 'at'>>();

/**
 * 按模型的累计。与 recent 分开维护：recent 有条数上限会滚掉旧记录，
 * 而模型累计要覆盖进程全生命周期。
 */
const modelStats = new Map<string, ModelStat>();

export function recordUsage(record: UsageRecord): void {
  totals.requests += 1;
  totals[record.backend] += 1;
  if (record.fallback) totals.fallbacks += 1;
  if (record.stream) totals.streaming += 1;
  totals.toolCalls += record.toolUses.length;
  totals.inputTokens += record.inputTokens;
  totals.outputTokens += record.outputTokens;
  totals.cacheReadTokens += record.cacheReadTokens ?? 0;
  totals.cacheCreationTokens += record.cacheCreationTokens ?? 0;
  if (record.deepseekReason) totals[REASON_FIELD[record.deepseekReason]] += 1;
  for (const name of record.toolUses) {
    toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
  }

  let stat = modelStats.get(record.model);
  if (!stat) {
    stat = {
      model: record.model,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      sider: 0,
      deepseek: 0,
      deepseekTools: 0,
      deepseekFallback: 0,
      deepseekRouting: 0,
    };
    modelStats.set(record.model, stat);
  }
  stat.requests += 1;
  stat.inputTokens += record.inputTokens;
  stat.outputTokens += record.outputTokens;
  stat.totalTokens += record.inputTokens + record.outputTokens;
  stat[record.backend] += 1;
  if (record.deepseekReason) stat[REASON_FIELD[record.deepseekReason]] += 1;

  recent.unshift({ at: Date.now(), record });
  if (recent.length > RECENT_LIMIT) {
    recent.length = RECENT_LIMIT;
  }

  addToTrendBucket(Date.now(), record);

}

/** 把一条记录累加进它所属的小时桶，并顺手淘汰滑出 24 小时窗口的旧桶。 */
function addToTrendBucket(at: number, record: UsageRecord): void {
  const key = Math.floor(at / BUCKET_MS) * BUCKET_MS;
  let bucket = trendBuckets.get(key);
  if (!bucket) {
    bucket = { requests: 0, inputTokens: 0, outputTokens: 0, sider: 0, deepseek: 0 };
    trendBuckets.set(key, bucket);
  }
  bucket.requests += 1;
  bucket.inputTokens += record.inputTokens;
  bucket.outputTokens += record.outputTokens;
  bucket[record.backend] += 1;

  // 桶数天然有界（24 个），但服务长跑时旧 key 会残留，写入时顺手清掉
  const oldest = key - (BUCKET_COUNT - 1) * BUCKET_MS;
  for (const existing of trendBuckets.keys()) {
    if (existing < oldest) trendBuckets.delete(existing);
  }
}

/**
 * 记录一次命中重复响应缓存的请求。这类请求没有触达任何上游，
 * 因此不计入 requests / 后端占比，单列出来是为了解释"我发了 N 次
 * 为什么统计只有 M 次"。
 */
export function recordCachedReplay(): void {
  totals.cachedReplays += 1;
}

/**
 * 近 24 小时按小时分桶。数据源是 `trendBuckets`（按桶独立累计），
 * 与请求总量无关，因此高流量下也不会失真。
 */
function buildTrend(now: number): TrendBucket[] {
  const currentBucket = Math.floor(now / BUCKET_MS) * BUCKET_MS;
  const trend: TrendBucket[] = [];

  // 空桶也保留，保证时间轴连续（缺口不会被折线连成斜线）
  for (let i = BUCKET_COUNT - 1; i >= 0; i -= 1) {
    const at = currentBucket - i * BUCKET_MS;
    const bucket = trendBuckets.get(at);
    trend.push({
      at: new Date(at).toISOString(),
      requests: bucket?.requests ?? 0,
      inputTokens: bucket?.inputTokens ?? 0,
      outputTokens: bucket?.outputTokens ?? 0,
      sider: bucket?.sider ?? 0,
      deepseek: bucket?.deepseek ?? 0,
    });
  }

  return trend;
}

/**
 * 命中率 = 命中 / prompt 总量。
 *
 * 分母必须是 `inputTokens + cacheRead + cacheCreation`：`inputTokens` 是**未命中的
 * 余量**，命中越多它越小，拿它单独当分母会算出恒等于 100% 的假命中率。
 */
export function formatCacheHitRate(
  counts: { inputTokens: number; cacheReadTokens: number; cacheCreationTokens: number },
): string {
  const prompt = counts.inputTokens + counts.cacheReadTokens + counts.cacheCreationTokens;
  if (prompt === 0) return '0.0%';
  return `${((counts.cacheReadTokens / prompt) * 100).toFixed(1)}%`;
}

export function getUsageSnapshot(now = Date.now()): UsageSnapshot {
  const pct = (part: number) =>
    totals.requests === 0 ? '0%' : `${Math.round((part / totals.requests) * 100)}%`;

  const lastHour = { requests: 0, sider: 0, deepseek: 0, fallbacks: 0 };
  for (const { at, record } of recent) {
    if (now - at > WINDOW_MS) break; // recent 按新在前排列，遇到更早的即可停
    lastHour.requests += 1;
    lastHour[record.backend] += 1;
    if (record.fallback) lastHour.fallbacks += 1;
  }

  const tools = [...toolCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, count]) => ({ name, count }));

  const models = [...modelStats.values()].sort((a, b) => b.requests - a.requests);

  return {
    since: new Date(startedAt).toISOString(),
    totals: { ...totals, cacheHitRate: formatCacheHitRate(totals) },
    backendShare: { sider: pct(totals.sider), deepseek: pct(totals.deepseek) },
    lastHour,
    models,
    trend: buildTrend(now),
    tools,
    siderThrottle: getSiderThrottleSnapshot(now),
    // Node 侧无 KV 遥测可聚合，恒为空。
    siderHealth: [],
    lifetimeRequests: totals.requests,
    siderStrategy: currentEffectiveSiderStrategy(),
    recent: recent.slice(0, RECENT_DISPLAY).map(({ at, record }) => ({
      time: new Date(at).toISOString(),
      model: record.model,
      backend: record.backend,
      fallback: record.fallback,
      reason: record.deepseekReason ?? null,
      tools: record.toolUses,
      stream: record.stream,
      ms: record.ms,
      tokens: record.inputTokens + record.outputTokens,
    })),
    note: '进程内统计，实例重启后清零；Deno Deploy 各隔离实例独立，仅代表当前实例',
    persisted: false,
  };
}

/**
 * Node/Bun 运行时没有 Deno KV，合并快照等价于进程内快照；
 * 保留同名导出使两侧调用方代码一致。
 */
export async function getStatsSnapshot(now = Date.now()): Promise<UsageSnapshot> {
  return getUsageSnapshot(now);
}

/** 仅供测试使用。 */
export function resetUsageStats(): void {
  totals = emptyTotals();
  toolCounts.clear();
  modelStats.clear();
  trendBuckets.clear();
  recent.length = 0;
}
