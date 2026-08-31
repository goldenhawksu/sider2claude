/**
 * Sider 调用运行遥测。
 *
 * 每次 Sider 调用记一条白名单字段，写进 Deno KV 的 `['tele', hourBucket, ts]` 键，
 * 供离线分析优化调度策略。本轮只攒数据、不做页面展示——分析维度还没定，
 * 先把可分析的数据保住。
 *
 * 三条设计取向，都从约束里来：
 *
 * 1. **零竞争写**：键用时间戳，天然唯一，`kv.set` 不需要 CAS、不需要串行队列。
 *    遥测是旁路数据，允许有损；一旦为了「精确条数」去读改写，就把写路径拖回了
 *    `['live']` 那种全局协调瓶颈，得不偿失。
 *
 * 2. **容量硬上限靠写入端节流**：每实例每小时最多写 `MAX_PER_HOUR` 条，超过就停。
 *    纯时间窗口回收不足以保证上限——高流量下窗口内条数仍无界，而精确裁剪需要
 *    计数器读改写，绕回上面的协调问题。写入端节流是唯一不引入协调的方案。
 *
 * 3. **回收走确定性扫描**，不用 `expireIn`（实测 `:memory:` KV 上写多久都不生效，
 *    本地测不出来的行为不能作为正确性依赖）。旧桶在读取扫描时顺手删，
 *    与趋势桶同一套路。
 *
 * 白名单字段不含任何消息内容——与 `recent` 明细的约束一致，遥测只记「发生了什么」，
 *    不记「说了什么」。
 */

/// <reference lib="deno.unstable" />

import type { SiderStrategy } from '../config/backends.ts';
import { getKv } from './usage-stats-kv.ts';

const BUCKET_MS = 60 * 60_000;
/** 遥测桶的保留跨度；超出的桶在读取扫描时回收。 */
const RETENTION_MS = 25 * BUCKET_MS;
/** 每实例每小时写入上限。上限 = 25 桶 × 本值 × 实例数。 */
const MAX_PER_HOUR = 40;

export interface SiderTelemetryRecord {
  ts: number;
  model: string;
  strategy: SiderStrategy;
  payloadChars: number;
  ok: boolean;
  /** 上游业务错误码（603 / 1135 等）；成功时为 0。 */
  siderCode: number;
  ms: number;
  hasTools: boolean;
  /** 是否从文本还原出了 tool_use（Max 策略下有意义）。 */
  restoredToolUse: boolean;
}

/** 当前小时的写入计数，进程内节流。 */
let currentHour = 0;
let writtenThisHour = 0;

/** 写出限制：遥测是旁路数据，超限宁可丢也不堆积。 */
function throttled(hourBucket: number): boolean {
  if (hourBucket !== currentHour) {
    currentHour = hourBucket;
    writtenThisHour = 0;
  }
  if (writtenThisHour >= MAX_PER_HOUR) {
    return true;
  }
  writtenThisHour += 1;
  return false;
}

export function persistSiderTelemetry(record: SiderTelemetryRecord): void {
  void (async () => {
    const kv = await getKv();
    if (!kv) return;

    const hourBucket = Math.floor(record.ts / BUCKET_MS) * BUCKET_MS;
    if (throttled(hourBucket)) {
      return;
    }

    await kv.set(['tele', hourBucket, record.ts], record).catch(() => {});
  })();
}

/**
 * 导出遥测原始记录（新在前），供离线分析。
 * KV 未启用或读取超时返回空数组——遥测永远不能拖垮请求。
 */
export async function readSiderTelemetry(now = Date.now()): Promise<SiderTelemetryRecord[]> {
  const kv = await getKv();
  if (!kv) return [];

  const windowStart = now - RETENTION_MS;
  const records: SiderTelemetryRecord[] = [];
  const staleKeys: Deno.KvKey[] = [];

  try {
    await Promise.race([
      (async () => {
        for await (const entry of kv.list({ prefix: ['tele'] })) {
          const key = entry.key;
          if (key.length !== 3) continue;
          const bucket = Number(key[1]);
          if (bucket < windowStart) {
            staleKeys.push(key);
            continue;
          }
          records.push(entry.value as SiderTelemetryRecord);
        }
      })(),
      // 读取带超时：遥测永远不能拖垮请求。
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  } catch {
    return [];
  }

  // fire-and-forget 回收：失败不影响本次读取，下次扫描还会遇到
  if (staleKeys.length > 0) {
    void (async () => {
      for (const key of staleKeys) await kv.delete(key).catch(() => {});
    })();
  }

  return records.sort((a, b) => b.ts - a.ts);
}

/** 仅供测试。 */
export function resetSiderTelemetry(): void {
  currentHour = 0;
  writtenThisHour = 0;
}

/**
 * 看板用：某个模型近期在 Sider 侧的表现。
 *
 * 与 `SiderThrottleStat` 的分工：那个是**进程内**的限流器实时状态（令牌桶速率、
 * 学到的体量上限），本结构是**跨实例**的实测结果聚合。生产上 Deploy 会拉起多个
 * 隔离实例并回收空闲实例，`/stats` 的快照几乎必然来自一个没有碰撞记录的实例，
 * 限流器那张表因此长期为空——遥测已经在 KV 里，正好补上这个观测缺口。
 */
export interface SiderHealthStat {
  model: string;
  attempts: number;
  ok: number;
  failed: number;
  /** 最近一次失败的业务错误码；无失败时为 0。 */
  lastCode: number;
  /** 最近一次失败时刻；无失败时为 0。 */
  lastFailedAt: number;
  /** 成功调用的平均耗时（毫秒，四舍五入）；无成功时为 0。 */
  avgMs: number;
}

/**
 * 只扫最近 `hours` 个小时桶来聚合，**不读满整个保留窗口**。
 *
 * `/stats` 每 5 秒刷新一次，而遥测的容量上限是 25 桶 × 40 条 × 实例数——全量扫描
 * 会让这张卡片的开销随实例数线性增长，正是趋势桶当初要避开的坑。「最近的碰撞
 * 情况」本来也只关心近期，扫两个桶足够。
 */
export async function aggregateSiderHealth(
  now = Date.now(),
  hours = 2,
): Promise<SiderHealthStat[]> {
  const kv = await getKv();
  if (!kv) return [];

  const currentBucket = Math.floor(now / BUCKET_MS) * BUCKET_MS;
  const oldestBucket = currentBucket - (hours - 1) * BUCKET_MS;

  const acc = new Map<string, SiderHealthStat & { okMsTotal: number }>();

  try {
    await Promise.race([
      (async () => {
        for await (
          const entry of kv.list({
            // 键是 ['tele', bucket, ts]，按 bucket 升序；限定 start 即可跳过旧桶。
            start: ['tele', oldestBucket],
            end: ['tele', currentBucket + BUCKET_MS],
          })
        ) {
          if (entry.key.length !== 3) continue;
          const r = entry.value as SiderTelemetryRecord;
          let row = acc.get(r.model);
          if (!row) {
            row = {
              model: r.model,
              attempts: 0,
              ok: 0,
              failed: 0,
              lastCode: 0,
              lastFailedAt: 0,
              avgMs: 0,
              okMsTotal: 0,
            };
            acc.set(r.model, row);
          }
          row.attempts += 1;
          if (r.ok) {
            row.ok += 1;
            row.okMsTotal += r.ms;
          } else {
            row.failed += 1;
            // 记最近一次：遥测按 ts 排列不保证，显式比时间戳。
            if (r.ts >= row.lastFailedAt) {
              row.lastFailedAt = r.ts;
              row.lastCode = r.siderCode;
            }
          }
        }
      })(),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  } catch {
    return [];
  }

  return [...acc.values()]
    .map(({ okMsTotal, ...row }) => ({
      ...row,
      avgMs: row.ok > 0 ? Math.round(okMsTotal / row.ok) : 0,
    }))
    // 失败多的排前面：这张卡是用来发现问题的，健康的模型不需要抢注意力。
    .sort((a, b) => b.failed - a.failed || b.attempts - a.attempts);
}
