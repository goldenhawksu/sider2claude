/**
 * 用量统计 KV 持久层的确定性测试。
 *
 * 运行在 STATS_KV 未设置的默认模式（:memory: KV）：同一进程内
 * "写入 → 读取 → 合并"全链路真实走 KV 代码路径，只是不落文件。
 * 跨进程持久性无法在单测里验证，属 Deploy 平台行为。
 */

import {
  getStatsSnapshot,
  recordUsage,
  resetSnapshotCache,
  resetUsageStats,
} from '../src/utils/usage-stats.ts';
import type { UsageSnapshot } from '../src/utils/usage-stats.ts';
import { closeStatsKv } from '../src/utils/usage-stats-kv.ts';

/** 显式启用 :memory: KV 并复位状态；结束后恢复环境并关闭 KV。 */
async function withMemoryKv(fn: () => Promise<void>): Promise<void> {
  const previous = Deno.env.get('STATS_KV');
  Deno.env.set('STATS_KV', 'memory');
  await closeStatsKv(); // 复位缓存的实例，让本次测试重新打开
  try {
    await fn();
  } finally {
    Deno.env.set('STATS_KV', previous ?? '');
    if (!previous) Deno.env.delete('STATS_KV');
    await closeStatsKv();
  }
}

function assertEquals<T>(actual: T, expected: T, what = '值') {
  if (actual !== expected) {
    throw new Error(`${what}：期望 ${String(expected)}，实际 ${String(actual)}`);
  }
}

/**
 * 轮询到快照满足条件为止。
 *
 * 不能用固定 sleep 等 KV 落库：写入是 fire-and-forget，且 `['live']` 的更新
 * 还要排队串行提交，耗时随机器负载浮动。实测在与 `deno fmt` 并发时，固定
 * 等待会偶发不够，让回归门禁无故变红——一个会偶发红的门禁等于没有门禁。
 *
 * 超时后照常返回最后一次快照，让断言给出真实差异而不是"超时"这种无信息报错。
 *
 * 每轮必须先清快照缓存：生产上那层 3 秒 TTL 缓存是为了让 /stats 的扫描频率
 * 与客户端数解耦，但在这里它会让轮询反复拿到同一份旧快照，把「25ms 轮询到
 * 就绪」退化成「每次都等满 3 秒」。测试要看的是 KV 的真实状态，不是缓存。
 */
async function waitForStats(
  ready: (snapshot: UsageSnapshot) => boolean,
  timeoutMs = 8_000,
): Promise<UsageSnapshot> {
  const deadline = Date.now() + timeoutMs;
  const read = async () => {
    resetSnapshotCache();
    return await getStatsSnapshot();
  };
  let snapshot = await read();

  while (!ready(snapshot) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    snapshot = await read();
  }

  return snapshot;
}

Deno.test({
  name: '用量 KV：写读合并全链路（:memory: 模式）',
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  await withMemoryKv(async () => {
    resetUsageStats();
    recordUsage({
      model: 'claude-haiku-4.5',
      backend: 'sider',
      fallback: false,
      toolUses: [],
      stream: false,
      ms: 100,
      inputTokens: 10,
      outputTokens: 5,
    });
    recordUsage({
      model: 'claude-sonnet-4.6',
      backend: 'deepseek',
      fallback: true,
      deepseekReason: 'fallback',
      toolUses: ['Bash', 'Read'],
      stream: true,
      ms: 200,
      inputTokens: 20,
      outputTokens: 8,
    });

    // persistUsage 是 fire-and-forget，轮询到落库为止
    const merged = await waitForStats((snap) => snap.totals.requests === 2);
    assertEquals(merged.persisted, true, ':memory: 模式下聚合应来自 KV 层');
    assertEquals(merged.totals.requests, 2, 'KV 请求总数');
    assertEquals(merged.totals.sider, 1, 'KV sider');
    assertEquals(merged.totals.deepseek, 1, 'KV deepseek');
    assertEquals(merged.totals.fallbacks, 1, 'KV fallback');
    assertEquals(merged.totals.streaming, 1, 'KV 流式');
    assertEquals(merged.totals.toolCalls, 2, 'KV 工具调用');
    assertEquals(merged.totals.inputTokens, 30, 'KV 输入 token');
    assertEquals(merged.totals.outputTokens, 13, 'KV 输出 token');

    assertEquals(merged.models.length, 2, 'KV 模型数');
    // 两模型各 1 次请求属平局，排序无承诺；断言内容而非顺序
    const sonnet = merged.models.find((m) => m.model === 'claude-sonnet-4.6');
    assertEquals(sonnet?.requests, 1, 'KV sonnet 请求数');
    assertEquals(sonnet?.totalTokens, 28, 'KV sonnet token 合计');
    assertEquals(sonnet?.deepseek, 1, 'KV sonnet 走 deepseek');

    const bash = merged.tools.find((t) => t.name === 'Bash');
    assertEquals(bash?.count, 1, 'KV 工具频次');

    // 趋势最后一个桶应含这两次请求
    const last = merged.trend[merged.trend.length - 1];
    assertEquals(last.requests, 2, 'KV 当前小时桶请求数');
    assertEquals(last.sider, 1, 'KV 当前小时桶 sider');
    assertEquals(last.deepseek, 1, 'KV 当前小时桶 deepseek');
  });
});

/**
 * KV 未启用时（STATS_KV 未设，默认降级）必须回退进程内快照。
 * 这是"不配 KV 也能用"的保证：功能降级为单实例，但不能变成一片空白。
 */
Deno.test({
  name: '用量 KV：未启用时 recent 与 lastHour 回退进程内',
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const previous = Deno.env.get('STATS_KV');
  Deno.env.delete('STATS_KV');
  await closeStatsKv();
  try {
    resetUsageStats();
    recordUsage({
      model: 'm',
      backend: 'sider',
      fallback: false,
      toolUses: [],
      stream: false,
      ms: 1,
      inputTokens: 1,
      outputTokens: 1,
    });
    const snap = await getStatsSnapshot();
    assertEquals(snap.persisted, false, 'KV 未启用');
    assertEquals(snap.recent.length, 1, 'recent 来自进程内');
    assertEquals(snap.recent[0].model, 'm', 'recent 模型');
    assertEquals(snap.lastHour.requests, 1, 'lastHour 来自进程内');
  } finally {
    if (previous) Deno.env.set('STATS_KV', previous);
    await closeStatsKv();
  }
});

/**
 * DeepSeek 归因必须一起进 KV。
 *
 * 生产上 /stats 的聚合读的是 KV（Deploy 多实例），归因只留在进程内的话，
 * 用户在看板上看到的三个分项会永远是 0，这个功能等于没做。
 */
Deno.test({
  name: '用量 KV：DeepSeek 归因按模型与总量持久化',
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  await withMemoryKv(async () => {
    resetUsageStats();
    const opus = (reason: 'tools' | 'fallback' | 'routing') => ({
      model: 'claude-opus-4.6',
      backend: 'deepseek' as const,
      fallback: reason === 'fallback',
      deepseekReason: reason,
      toolUses: [],
      stream: false,
      ms: 1,
      inputTokens: 0,
      outputTokens: 0,
    });
    recordUsage(opus('tools'));
    recordUsage(opus('tools'));
    recordUsage(opus('fallback'));
    recordUsage(opus('routing'));

    const merged = await waitForStats((snap) => snap.totals.requests === 4);
    assertEquals(merged.persisted, true, '应来自 KV 层');
    assertEquals(merged.totals.deepseekTools, 2, 'KV 总量工具归因');
    assertEquals(merged.totals.deepseekFallback, 1, 'KV 总量受限兜底归因');
    assertEquals(merged.totals.deepseekRouting, 1, 'KV 总量策略归因');

    const opusRow = merged.models.find((m) => m.model === 'claude-opus-4.6');
    assertEquals(opusRow?.deepseekTools, 2, 'KV 模型工具归因');
    assertEquals(opusRow?.deepseekFallback, 1, 'KV 模型受限兜底归因');
    assertEquals(opusRow?.deepseekRouting, 1, 'KV 模型策略归因');
    // 不变式在持久层同样成立
    assertEquals(
      (opusRow?.deepseekTools ?? 0) + (opusRow?.deepseekFallback ?? 0) +
        (opusRow?.deepseekRouting ?? 0),
      opusRow?.deepseek,
      'KV 模型分项求和',
    );
  });
});

/**
 * recent 明细与 lastHour 也持久化到 KV。
 *
 * 动机：Deno Deploy 会拉起多个隔离实例，纯进程内的明细意味着用户打开
 * /stats 很可能命中一个没处理过请求的实例，明细与最近 1 小时全是空的。
 * 下面用「写完之后清空进程内状态」模拟这一幕。
 */
Deno.test({
  name: '用量 KV：清空进程内状态后，recent 与 lastHour 仍能从 KV 还原',
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  await withMemoryKv(async () => {
    resetUsageStats();
    const rec = (o: Record<string, unknown> = {}) => ({
      model: 'm',
      backend: 'sider' as const,
      fallback: false,
      toolUses: [] as string[],
      stream: false,
      ms: 10,
      inputTokens: 1,
      outputTokens: 1,
      ...o,
    });
    recordUsage(rec({ model: 'a' }));
    recordUsage(
      rec({ model: 'b', backend: 'deepseek', deepseekReason: 'tools', toolUses: ['Bash'] }),
    );
    recordUsage(
      rec({ model: 'c', backend: 'deepseek', fallback: true, deepseekReason: 'fallback' }),
    );
    resetUsageStats(); // 模拟命中另一个（空的）实例
    const snap = await waitForStats((s) => s.recent.length === 3);

    assertEquals(snap.persisted, true, '应来自 KV');
    assertEquals(snap.recent.length, 3, 'recent 条数');
    assertEquals(snap.recent.map((r) => r.model).join(','), 'c,b,a', 'recent 新在前');
    assertEquals(snap.recent[0].reason, 'fallback', 'recent 归因随明细一起持久化');
    assertEquals(snap.recent[1].tools.join(','), 'Bash', 'recent 工具名');

    assertEquals(snap.lastHour.requests, 3, 'lastHour 请求数');
    assertEquals(snap.lastHour.sider, 1, 'lastHour sider');
    assertEquals(snap.lastHour.deepseek, 2, 'lastHour deepseek');
    assertEquals(snap.lastHour.fallbacks, 1, 'lastHour fallback');

    // 白名单不能因为过了一趟 KV 就被撑大
    const allowed = [
      'time',
      'model',
      'backend',
      'fallback',
      'reason',
      'tools',
      'stream',
      'ms',
      'tokens',
    ];
    assertEquals(
      Object.keys(snap.recent[0]).sort().join(','),
      allowed.sort().join(','),
      'recent 字段集合',
    );
  });
});

/**
 * 并发写不能丢明细。
 *
 * `['live']` 用 CAS 更新，而 persistUsage 是 fire-and-forget：若不串行化，
 * 并发请求会读到同一个 versionstamp 争抢同一次提交，只有一个能赢。
 * 实测未串行化时并发写 30 条只活下来 4 条。
 */
Deno.test({
  name: '用量 KV：并发写入不丢明细（CAS 竞争回归）',
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  await withMemoryKv(async () => {
    resetUsageStats();
    for (let i = 0; i < 30; i += 1) {
      recordUsage({
        model: `x${i}`,
        backend: 'sider',
        fallback: false,
        toolUses: [],
        stream: false,
        ms: 1,
        inputTokens: 1,
        outputTokens: 0,
      });
    }
    resetUsageStats();
    const snap = await waitForStats((s) => s.lastHour.requests === 30);
    assertEquals(snap.recent.length, 10, '展示条数（KV 内保留 20 条，展示截 10）');
    assertEquals(snap.recent[0].model, 'x29', '最新一条没有被竞争吃掉');
    assertEquals(snap.lastHour.requests, 30, 'lastHour 计满 30 条');
  });
});

Deno.test({
  name: '用量 KV：lastHour 窗口相对读取时刻，旧分钟桶不再计入',
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  await withMemoryKv(async () => {
    resetUsageStats();
    recordUsage({
      model: 'm',
      backend: 'sider',
      fallback: false,
      toolUses: [],
      stream: false,
      ms: 1,
      inputTokens: 0,
      outputTokens: 0,
    });
    const now = await waitForStats((s) => s.lastHour.requests === 1);
    assertEquals(now.lastHour.requests, 1, '当下窗口内');

    // 把「现在」推到 2 小时后：那条记录应滑出窗口
    const future = await getStatsSnapshot(Date.now() + 2 * 60 * 60_000);
    assertEquals(future.lastHour.requests, 0, '窗口外不计入');
    assertEquals(future.totals.requests, 1, '总量不受窗口影响');
  });
});
