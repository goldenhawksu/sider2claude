/**
 * 用量统计的 Deno KV 持久层。
 *
 * 两块存储，形态不同：
 * 1. 聚合计数（总量/模型/趋势/工具频次）用 `['stats', ...]` 下的 sum mutation，
 *    无竞争、可原子累加，一次 atomic commit 提交一个请求的全部增量。
 * 2. 明细与滑动窗口（`recent` / `lastHour`）用**单个** `['live']` key 存
 *    `{recent, minutes}`，靠 check-versionstamp 的 CAS 更新。
 *
 * 为什么明细不是"一条一个 key"：`/stats` 每 5 秒自动刷新一次，那样每次刷新
 * 都要 list 几百个 key。定长数组塞进一个 key，读取恒为 1 次 get。
 *
 * 为什么不用 `expireIn` 做过期：实测 `:memory:` KV 上写多久都不生效
 * （Deno 2.5.4），本地测不出来的行为不能作为正确性依赖。改为确定性回收：
 * `recent`/`minutes` 在写入时按长度和窗口裁剪，趋势旧桶在读取扫描时顺手删。
 *
 * fire-and-forget 执行，不阻塞响应路径；任何失败静默降级为纯进程内统计。
 *
 * 模式选择（STATS_KV 环境变量）：
 * - "kv"：默认 openKv()。在 Deno Deploy 上连接平台分配的数据库（需先在
 *   后台 Databases 里 Provision 一个 Deno KV 并关联本应用）。
 * - 未设 / "memory"：openKv(":memory:")，行为与旧版纯内存一致，重启清零，
 *   不在本地落任何文件。
 */

/// <reference lib="deno.unstable" />
// KV 在当前 Deno 稳定版仍属 unstable：类型靠上面的 lib 引入，
// 运行时需要 --unstable-kv 标志（deno.json 的任务里已加；
// Deno Deploy 平台默认开放 unstable API）。

import type { Backend } from '../config/backends.ts';
import type { DeepSeekReason, UsageRecord } from './usage-stats.ts';

const BUCKET_MS = 60 * 60_000;
const MINUTE_MS = 60_000;
/** lastHour 的滑动窗口跨度，也是分钟桶的保留条数。 */
const LASTHOUR_MINUTES = 60;
/** `['live']` 里保留的明细条数。看板只展示 10 条，留一倍余量。 */
const LIVE_RECENT_LIMIT = 20;
/** 趋势桶的保留跨度；超出的桶在读取扫描时回收。 */
const TREND_RETENTION_MS = 25 * BUCKET_MS;

/** DeepSeek 归因 -> KV 字段名；与 usage-stats.ts 的计数字段同名。 */
const REASON_FIELD: Record<DeepSeekReason, string> = {
  tools: 'deepseekTools',
  fallback: 'deepseekFallback',
  routing: 'deepseekRouting',
};

/** 模型行里允许累加的字段，防止未知 key 混进聚合。 */
const MODEL_FIELDS = new Set([
  'requests',
  'sider',
  'deepseek',
  'inputTokens',
  'outputTokens',
  'deepseekTools',
  'deepseekFallback',
  'deepseekRouting',
]);

/**
 * 趋势桶里允许累加的字段。
 *
 * 与 `totals` 逐字段对齐：看板的顶部磁贴与后端占比都由 24 个趋势桶求和得出，
 * 少一个字段那一项就恒为 0。新增 totals 字段时必须同步加进来。
 */
const TREND_FIELDS = new Set([
  'requests',
  'sider',
  'deepseek',
  'inputTokens',
  'outputTokens',
  'fallbacks',
  'streaming',
  'toolCalls',
  'cachedReplays',
  'deepseekTools',
  'deepseekFallback',
  'deepseekRouting',
]);

/**
 * 模型 × 小时的字段集。
 *
 * 比 MODEL_FIELDS 少一个 `sider`：它恒等于 `requests - deepseek`，存进去只是
 * 让每个模型每小时多占一个 key。这类 key 数量是「活跃模型 × 25 桶 × 字段数」，
 * 省一个字段就是省 25 × 模型数个 key，而 /stats 每次刷新都要扫它们。
 */
const MODEL_HOUR_FIELDS = new Set([
  'requests',
  'inputTokens',
  'outputTokens',
  'deepseek',
  'deepseekTools',
  'deepseekFallback',
  'deepseekRouting',
]);

type Mutate = Parameters<Deno.AtomicOperation['mutate']>[0];

let kvPromise: Promise<Deno.Kv | null> | null = null;

/**
 * 懒加载 KV。两种模式都走完整的写读路径（:memory: 与真 KV 代码路径一致，
 * 测试因此能覆盖全链路），区别只在介质：memory 重启即清、不落文件。
 * 失败只记一次日志，此后永久降级为 null（纯进程内统计）。
 */
export function getKv(): Promise<Deno.Kv | null> {
  if (!kvPromise) {
    kvPromise = (async () => {
      try {
        const mode = (Deno.env.get('STATS_KV') ?? '').toLowerCase();
        if (!mode) return null; // 未显式启用：完全跳过，行为同纯进程内
        const kv = mode === 'kv' ? await Deno.openKv() : await Deno.openKv(':memory:');
        // 首次写入时记下统计起点（check 不存在才写，重启后才会产生新值）
        await kv.atomic()
          .check({ key: ['stats', 'since'], versionstamp: null })
          .set(['stats', 'since'], Date.now())
          .commit()
          .catch(() => {});
        return kv;
      } catch (error) {
        console.warn('Usage stats KV unavailable, falling back to in-memory:', {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    })();
  }
  return kvPromise;
}

/** 仅供测试：关闭 KV，避免 Deno.test 的资源泄漏检查报错。 */
export async function closeStatsKv(): Promise<void> {
  const kv = await getKv();
  await kv?.close();
  kvPromise = null;
}

const num = (value: unknown): number =>
  typeof value === 'bigint' ? Number(value) : Number(value ?? 0);

/**
 * 把一次请求的增量原子提交到 KV。不 await 调用方（fire-and-forget），
 * 失败静默——统计缺一两条远比拖垮请求响应糟糕。
 */
export function persistUsage(record: UsageRecord): void {
  void (async () => {
    const kv = await getKv();
    if (!kv) return;

    const bucket = Math.floor(Date.now() / BUCKET_MS) * BUCKET_MS;
    const ops: Mutate[] = [];

    const sum = (key: Deno.KvKey, n: number) => {
      if (n > 0) ops.push({ key, type: 'sum', value: new Deno.KvU64(BigInt(n)) });
    };

    sum(['stats', 'requests'], 1);
    sum(['stats', record.backend], 1);
    sum(['stats', 'inputTokens'], record.inputTokens);
    sum(['stats', 'outputTokens'], record.outputTokens);
    if (record.fallback) sum(['stats', 'fallbacks'], 1);
    if (record.stream) sum(['stats', 'streaming'], 1);
    sum(['stats', 'toolCalls'], record.toolUses.length);
    for (const name of record.toolUses) sum(['stats', 'tool', name], 1);

    // DeepSeek 承接来源；字段名与 UsageSnapshot.totals / ModelStat 一致，
    // collect() 因此不需要额外映射。
    const reasonField = record.deepseekReason && REASON_FIELD[record.deepseekReason];

    const m = ['stats', 'model', record.model];
    sum([...m, 'requests'], 1);
    sum([...m, record.backend], 1);
    sum([...m, 'inputTokens'], record.inputTokens);
    sum([...m, 'outputTokens'], record.outputTokens);
    if (reasonField) {
      sum(['stats', reasonField], 1);
      sum([...m, reasonField], 1);
    }

    // 趋势桶承担双重职责：既画趋势图，又是看板 24 小时窗口下 totals 的来源，
    // 因此这里要写全 totals 的每一个字段，不能只写画图用的那几个。
    const t = ['stats', 'trend', bucket];
    sum([...t, 'requests'], 1);
    sum([...t, record.backend], 1);
    sum([...t, 'inputTokens'], record.inputTokens);
    sum([...t, 'outputTokens'], record.outputTokens);
    if (record.fallback) sum([...t, 'fallbacks'], 1);
    if (record.stream) sum([...t, 'streaming'], 1);
    sum([...t, 'toolCalls'], record.toolUses.length);
    if (reasonField) sum([...t, reasonField], 1);

    // 模型 × 小时、工具 × 小时：独立前缀，不塞进 ['stats']。
    // 塞进去会让 collect() 那一次全量前缀扫描从几百 key 涨到几千，
    // 而 /stats 每 5 秒就扫一次。独立前缀便于单独度量与回收。
    const mh = ['mstat', bucket, record.model];
    sum([...mh, 'requests'], 1);
    sum([...mh, 'inputTokens'], record.inputTokens);
    sum([...mh, 'outputTokens'], record.outputTokens);
    if (record.backend === 'deepseek') sum([...mh, 'deepseek'], 1);
    if (reasonField) sum([...mh, reasonField], 1);

    for (const name of record.toolUses) sum(['tstat', bucket, name], 1);

    await kv.atomic()
      .mutate(...ops)
      .commit()
      .catch(() => {
        // 静默：KV 抖动不应产生日志噪音，进程内统计仍在
      });

    enqueueLive(kv, record);
  })();
}

/**
 * 同实例内串行化 `['live']` 的更新。
 *
 * 为什么必须串行：`persistUsage` 是 fire-and-forget，并发请求会同时读到同一个
 * versionstamp，然后争抢同一次 CAS——只有一个能提交，其余全部丢失。实测并发
 * 写 30 条只活下来 4 条。排成队列后每次 CAS 都能读到上一条的结果，同实例内
 * 零竞争；跨实例的竞争交给 updateLive 里的重试。
 *
 * 队列有深度上限：极端流量下宁可丢观测数据，也不能让待处理的写无限堆积。
 */
let liveQueue: Promise<unknown> = Promise.resolve();
let livePending = 0;
const LIVE_QUEUE_LIMIT = 64;

function enqueueLive(kv: Deno.Kv, record: UsageRecord): void {
  if (livePending >= LIVE_QUEUE_LIMIT) return;
  livePending += 1;
  liveQueue = liveQueue
    .then(() => updateLive(kv, record))
    .catch(() => {})
    .finally(() => {
      livePending -= 1;
    });
}

/** `['live']` 里的一条明细。字段集与 UsageSnapshot.recent 一致（白名单）。 */
interface LiveRecent {
  at: number;
  model: string;
  backend: Backend;
  fallback: boolean;
  reason: DeepSeekReason | null;
  tools: string[];
  stream: boolean;
  ms: number;
  tokens: number;
}

/** 一个分钟桶。lastHour 由最近 60 个这样的桶求和得到（真滑动窗口）。 */
interface LiveMinute {
  m: number;
  requests: number;
  sider: number;
  deepseek: number;
  fallbacks: number;
}

interface LiveState {
  recent: LiveRecent[];
  minutes: LiveMinute[];
}

/**
 * CAS 更新 `['live']`。同实例内的并发已被 enqueueLive 串行化，这里的重试
 * 只用于跨实例竞争：另一个 isolate 抢先提交会让 check(versionstamp) 失败。
 * 三次都失败就放弃这一条明细——这是观测数据，掉一条远好于在响应路径上重试到底。
 */
async function updateLive(kv: Deno.Kv, record: UsageRecord): Promise<void> {
  const at = Date.now();
  const minute = Math.floor(at / MINUTE_MS) * MINUTE_MS;
  const oldestMinute = minute - (LASTHOUR_MINUTES - 1) * MINUTE_MS;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const entry = await kv.get<LiveState>(['live']);
    const state: LiveState = entry.value ?? { recent: [], minutes: [] };

    state.recent.unshift({
      at,
      model: record.model,
      backend: record.backend,
      fallback: record.fallback,
      reason: record.deepseekReason ?? null,
      tools: record.toolUses,
      stream: record.stream,
      ms: record.ms,
      tokens: record.inputTokens + record.outputTokens,
    });
    if (state.recent.length > LIVE_RECENT_LIMIT) {
      state.recent.length = LIVE_RECENT_LIMIT;
    }

    let bucket = state.minutes.find((b) => b.m === minute);
    if (!bucket) {
      bucket = { m: minute, requests: 0, sider: 0, deepseek: 0, fallbacks: 0 };
      state.minutes.push(bucket);
    }
    bucket.requests += 1;
    bucket[record.backend] += 1;
    if (record.fallback) bucket.fallbacks += 1;

    // 滑出窗口的分钟桶直接丢弃，`['live']` 的体积因此恒定有界
    state.minutes = state.minutes
      .filter((b) => b.m >= oldestMinute)
      .sort((a, b) => a.m - b.m);

    const result = await kv.atomic()
      .check(entry)
      .set(['live'], state)
      .commit();
    if (result.ok) return;
  }
}

export function persistCachedReplay(): void {
  void (async () => {
    const kv = await getKv();
    if (!kv) return;
    // 同时写全时累计与当前小时桶：前者留作页脚的历史对照，
    // 后者才是看板 24 小时窗口的数据来源。
    const bucket = Math.floor(Date.now() / BUCKET_MS) * BUCKET_MS;
    await kv.atomic()
      .mutate({ key: ['stats', 'cachedReplays'], type: 'sum', value: new Deno.KvU64(1n) })
      .mutate({
        key: ['stats', 'trend', bucket, 'cachedReplays'],
        type: 'sum',
        value: new Deno.KvU64(1n),
      })
      .commit()
      .catch(() => {});
  })();
}

/** KV 持久化的聚合视图；KV 未启用时返回 null（调用方回退进程内）。 */
export interface PersistentStats {
  since: number;
  totals: {
    requests: number;
    sider: number;
    deepseek: number;
    fallbacks: number;
    streaming: number;
    toolCalls: number;
    cachedReplays: number;
    inputTokens: number;
    outputTokens: number;
    deepseekTools: number;
    deepseekFallback: number;
    deepseekRouting: number;
  };
  models: Array<{
    model: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    sider: number;
    deepseek: number;
    deepseekTools: number;
    deepseekFallback: number;
    deepseekRouting: number;
  }>;
  tools: Array<{ name: string; count: number }>;
  trend: Array<{
    bucket: number;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    sider: number;
    deepseek: number;
  }>;
  /** 最近明细（新在前）。来自 `['live']`，跨实例。 */
  recent: LiveRecent[];
  /** 由分钟桶求和得到的滑动 1 小时窗口。 */
  lastHour: { requests: number; sider: number; deepseek: number; fallbacks: number };
  /**
   * 开服以来的累计请求数。
   *
   * 看板主体已统一到 24 小时窗口，这个数只在页脚做一行对照——留着它是因为
   * `['stats', ...]` 的全时累计一直在写，丢掉等于把历史数据藏起来。
   */
  lifetimeRequests: number;
}

/** 读取持久化聚合；带超时，KV 不可用或超时返回 null。 */
export async function readPersistentStats(now = Date.now()): Promise<PersistentStats | null> {
  const kv = await getKv();
  if (!kv) return null;

  try {
    const result = await Promise.race([
      collect(kv, now),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_000)),
    ]);
    return result;
  } catch {
    return null;
  }
}

/** 把 `['live']` 折算成明细列表与滑动窗口聚合；缺失时返回空值而非 null。 */
function summarizeLive(state: LiveState | null, now: number): {
  recent: LiveRecent[];
  lastHour: PersistentStats['lastHour'];
} {
  const lastHour = { requests: 0, sider: 0, deepseek: 0, fallbacks: 0 };
  if (!state) return { recent: [], lastHour };

  // 窗口相对读取时刻计算：服务闲置一小时后，残留的旧桶不能再算进"最近 1 小时"
  const cutoff = now - LASTHOUR_MINUTES * MINUTE_MS;
  for (const bucket of state.minutes) {
    if (bucket.m <= cutoff) continue;
    lastHour.requests += bucket.requests;
    lastHour.sider += bucket.sider;
    lastHour.deepseek += bucket.deepseek;
    lastHour.fallbacks += bucket.fallbacks;
  }

  return { recent: state.recent, lastHour };
}

async function collect(kv: Deno.Kv, now: number): Promise<PersistentStats | null> {
  const [sinceEntry, liveEntry] = await Promise.all([
    kv.get(['stats', 'since']),
    kv.get<LiveState>(['live']),
  ]);
  const totals = {
    requests: 0,
    sider: 0,
    deepseek: 0,
    fallbacks: 0,
    streaming: 0,
    toolCalls: 0,
    cachedReplays: 0,
    inputTokens: 0,
    outputTokens: 0,
    deepseekTools: 0,
    deepseekFallback: 0,
    deepseekRouting: 0,
  };

  const models: PersistentStats['models'] = [];
  const toolCounts = new Map<string, number>();
  const trend: PersistentStats['trend'] = [];
  const staleKeys: Deno.KvKey[] = [];
  let lifetimeRequests = 0;

  // 窗口起点：早于它的桶既不参与聚合，也顺手回收。
  const windowStart = now - TREND_RETENTION_MS;

  for await (const entry of kv.list({ prefix: ['stats'] })) {
    const key = entry.key;
    const value = num(entry.value);

    if (key[1] === 'trend' && key.length === 4) {
      const bucket = Number(key[2]);
      const field = key[3] as string;
      // 趋势桶永不覆盖写，服务长跑会无限堆积；而 /stats 每 5 秒全扫一次，
      // 堆积直接变成刷新开销。在这里顺手回收，不额外扫一遍。
      if (bucket < windowStart) {
        staleKeys.push(key);
        continue;
      }
      if (!TREND_FIELDS.has(field)) continue;

      let row = trend.find((t) => t.bucket === bucket);
      if (!row) {
        row = { bucket, requests: 0, inputTokens: 0, outputTokens: 0, sider: 0, deepseek: 0 };
        trend.push(row);
      }
      if (field in row) {
        (row as unknown as Record<string, number>)[field] += value;
      }
      // 看板已统一到 24 小时窗口：totals 由窗口内的桶求和得出，
      // 而不是读 `['stats', field]` 那份开天辟地以来的累计。
      if (field in totals) {
        (totals as unknown as Record<string, number>)[field] += value;
      }
      continue;
    }

    // 全时累计只留一个数给页脚做对照，其余字段不再驱动看板。
    if (key.length === 2 && key[1] === 'requests') {
      lifetimeRequests += value;
    }
  }

  // 模型 × 小时（独立前缀，与上面那次扫描分开，便于单独度量开销）
  for await (const entry of kv.list({ prefix: ['mstat'] })) {
    const key = entry.key;
    if (key.length !== 4) continue;
    const bucket = Number(key[1]);
    if (bucket < windowStart) {
      staleKeys.push(key);
      continue;
    }
    const field = key[3] as string;
    if (!MODEL_HOUR_FIELDS.has(field)) continue;

    const model = key[2] as string;
    let row = models.find((m) => m.model === model);
    if (!row) {
      row = {
        model,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        sider: 0,
        deepseek: 0,
        deepseekTools: 0,
        deepseekFallback: 0,
        deepseekRouting: 0,
      };
      models.push(row);
    }
    (row as unknown as Record<string, number>)[field] += num(entry.value);
  }

  // sider 不单独存，由 requests - deepseek 还原（省下每模型每小时一个 key）
  for (const row of models) {
    row.sider = Math.max(0, row.requests - row.deepseek);
  }

  // 工具 × 小时
  for await (const entry of kv.list({ prefix: ['tstat'] })) {
    const key = entry.key;
    if (key.length !== 3) continue;
    const bucket = Number(key[1]);
    if (bucket < windowStart) {
      staleKeys.push(key);
      continue;
    }
    const name = key[2] as string;
    toolCounts.set(name, (toolCounts.get(name) ?? 0) + num(entry.value));
  }

  const tools = [...toolCounts.entries()].map(([name, count]) => ({ name, count }));

  models.sort((a, b) => b.requests - a.requests);
  tools.sort((a, b) => b.count - a.count);
  trend.sort((a, b) => a.bucket - b.bucket);

  // fire-and-forget：回收失败不影响本次读取，下次扫描还会再遇到这些 key
  if (staleKeys.length > 0) {
    void (async () => {
      for (const key of staleKeys) await kv.delete(key).catch(() => {});
    })();
  }

  const live = summarizeLive(liveEntry.value, now);

  return {
    since: num(sinceEntry.value) || Date.now(),
    totals,
    models,
    tools,
    trend,
    recent: live.recent,
    lastHour: live.lastHour,
    lifetimeRequests,
  };
}
