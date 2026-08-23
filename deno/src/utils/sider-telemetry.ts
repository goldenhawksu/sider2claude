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
