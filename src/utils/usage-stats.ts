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

import type { Backend } from '../config/backends';

/** 最近明细的保留上限；内存占用很小（每条约 200 字节）。 */
const RECENT_LIMIT = 200;
/** 对外展示的最近条数；足够看清趋势，又不至于刷屏。 */
const RECENT_DISPLAY = 10;
/** 滑动窗口聚合的跨度。 */
const WINDOW_MS = 60 * 60_000;

export interface UsageRecord {
  model: string;
  backend: Backend;
  /** 实际后端与路由初判不同 = 发生过 fallback。 */
  fallback: boolean;
  /** 本次响应中真实发生的 tool_use 块的工具名。 */
  toolUses: string[];
  stream: boolean;
  ms: number;
}

interface RecentEntry {
  at: number;
  record: UsageRecord;
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
  /** 工具调用频次 Top 8，按次数降序。 */
  tools: Array<{ name: string; count: number }>;
  /** 最近请求（新在前）。不含任何消息内容或 token。 */
  recent: Array<{
    time: string;
    model: string;
    backend: Backend;
    fallback: boolean;
    tools: string[];
    stream: boolean;
    ms: number;
  }>;
  note: string;
}

const startedAt = Date.now();
let totals = {
  requests: 0,
  sider: 0,
  deepseek: 0,
  fallbacks: 0,
  streaming: 0,
  toolCalls: 0,
  cachedReplays: 0,
};
const toolCounts = new Map<string, number>();
const recent: RecentEntry[] = [];

export function recordUsage(record: UsageRecord): void {
  totals.requests += 1;
  totals[record.backend] += 1;
  if (record.fallback) totals.fallbacks += 1;
  if (record.stream) totals.streaming += 1;
  totals.toolCalls += record.toolUses.length;
  for (const name of record.toolUses) {
    toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
  }

  recent.unshift({ at: Date.now(), record });
  if (recent.length > RECENT_LIMIT) {
    recent.length = RECENT_LIMIT;
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

  return {
    since: new Date(startedAt).toISOString(),
    totals: { ...totals },
    backendShare: { sider: pct(totals.sider), deepseek: pct(totals.deepseek) },
    lastHour,
    tools,
    recent: recent.slice(0, RECENT_DISPLAY).map(({ at, record }) => ({
      time: new Date(at).toISOString(),
      model: record.model,
      backend: record.backend,
      fallback: record.fallback,
      tools: record.toolUses,
      stream: record.stream,
      ms: record.ms,
    })),
    note: '进程内统计，实例重启后清零；Deno Deploy 各隔离实例独立，仅代表当前实例',
  };
}

/** 仅供测试使用。 */
export function resetUsageStats(): void {
  totals = {
    requests: 0,
    sider: 0,
    deepseek: 0,
    fallbacks: 0,
    streaming: 0,
    toolCalls: 0,
    cachedReplays: 0,
  };
  toolCounts.clear();
  recent.length = 0;
}
