/**
 * 用量统计的 Deno KV 持久层。
 *
 * 只存聚合（数值），不存明细——recent 明细留在进程内。每请求的全部增量
 * 编码成一次 atomic commit（多个 sum mutation），fire-and-forget 执行，
 * 不阻塞响应路径；任何失败静默降级为纯进程内统计。
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

import type { UsageRecord } from './usage-stats.ts';

const BUCKET_MS = 60 * 60_000;

type Mutate = Parameters<Deno.AtomicOperation['mutate']>[0];

let kvPromise: Promise<Deno.Kv | null> | null = null;

/**
 * 懒加载 KV。两种模式都走完整的写读路径（:memory: 与真 KV 代码路径一致，
 * 测试因此能覆盖全链路），区别只在介质：memory 重启即清、不落文件。
 * 失败只记一次日志，此后永久降级为 null（纯进程内统计）。
 */
function getKv(): Promise<Deno.Kv | null> {
  if (!kvPromise) {
    kvPromise = (async () => {
      try {
        const mode = (Deno.env.get('STATS_KV') ?? '').toLowerCase();
        if (!mode) return null; // 未显式启用：完全跳过，行为同纯进程内
        const kv = mode === 'kv'
          ? await Deno.openKv()
          : await Deno.openKv(':memory:');
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

    const m = ['stats', 'model', record.model];
    sum([...m, 'requests'], 1);
    sum([...m, record.backend], 1);
    sum([...m, 'inputTokens'], record.inputTokens);
    sum([...m, 'outputTokens'], record.outputTokens);

    const t = ['stats', 'trend', bucket];
    sum([...t, 'requests'], 1);
    sum([...t, record.backend], 1);
    sum([...t, 'inputTokens'], record.inputTokens);
    sum([...t, 'outputTokens'], record.outputTokens);

    await kv.atomic()
      .mutate(...ops)
      .commit()
      .catch(() => {
        // 静默：KV 抖动不应产生日志噪音，进程内统计仍在
      });
  })();
}

export function persistCachedReplay(): void {
  void (async () => {
    const kv = await getKv();
    if (!kv) return;
    await kv.atomic()
      .mutate({ key: ['stats', 'cachedReplays'], type: 'sum', value: new Deno.KvU64(1n) })
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
  };
  models: Array<{
    model: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    sider: number;
    deepseek: number;
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
}

/** 读取持久化聚合；带超时，KV 不可用或超时返回 null。 */
export async function readPersistentStats(): Promise<PersistentStats | null> {
  const kv = await getKv();
  if (!kv) return null;

  try {
    const result = await Promise.race([
      collect(kv),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_000)),
    ]);
    return result;
  } catch {
    return null;
  }
}

async function collect(kv: Deno.Kv): Promise<PersistentStats | null> {
  const sinceEntry = await kv.get(['stats', 'since']);
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
  };

  const models: PersistentStats['models'] = [];
  const tools: PersistentStats['tools'] = [];
  const trend: PersistentStats['trend'] = [];

  // 前缀扫描模型与工具；个人代理量级下条目数有限
  for await (const entry of kv.list({ prefix: ['stats'] })) {
    const key = entry.key;
    const value = num(entry.value);

    if (key[1] === 'model' && key.length === 4) {
      const model = key[2] as string;
      const field = key[3] as string;
      let row = models.find((m) => m.model === model);
      if (!row) {
        row = { model, requests: 0, inputTokens: 0, outputTokens: 0, sider: 0, deepseek: 0 };
        models.push(row);
      }
      if (field === 'requests' || field === 'sider' || field === 'deepseek' ||
        field === 'inputTokens' || field === 'outputTokens') {
        (row as unknown as Record<string, number>)[field] += value;
      }
      continue;
    }

    if (key[1] === 'trend' && key.length === 4) {
      const bucket = Number(key[2]);
      const field = key[3] as string;
      let row = trend.find((t) => t.bucket === bucket);
      if (!row) {
        row = { bucket, requests: 0, inputTokens: 0, outputTokens: 0, sider: 0, deepseek: 0 };
        trend.push(row);
      }
      if (field === 'requests' || field === 'sider' || field === 'deepseek' ||
        field === 'inputTokens' || field === 'outputTokens') {
        (row as unknown as Record<string, number>)[field] += value;
      }
      continue;
    }

    if (key[1] === 'tool' && key.length === 3) {
      tools.push({ name: key[2] as string, count: value });
      continue;
    }

    if (key.length === 2 && key[1] !== 'since') {
      const field = key[1] as string;
      if (field in totals) {
        (totals as unknown as Record<string, number>)[field] += value;
      }
    }
  }

  models.sort((a, b) => b.requests - a.requests);
  tools.sort((a, b) => b.count - a.count);
  trend.sort((a, b) => a.bucket - b.bucket);

  return {
    since: num(sinceEntry.value) || Date.now(),
    totals,
    models,
    tools,
    trend,
  };
}
