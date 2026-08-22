/**
 * 用量统计 KV 持久层的确定性测试。
 *
 * 运行在 STATS_KV 未设置的默认模式（:memory: KV）：同一进程内
 * "写入 → 读取 → 合并"全链路真实走 KV 代码路径，只是不落文件。
 * 跨进程持久性无法在单测里验证，属 Deploy 平台行为。
 */

import { getStatsSnapshot, recordUsage, resetUsageStats } from '../src/utils/usage-stats.ts';
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

    // persistUsage 是 fire-and-forget，给它落库的时间
    await new Promise((resolve) => setTimeout(resolve, 150));

    const merged = await getStatsSnapshot();
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

Deno.test({
  name: '用量 KV：recent 明细与 lastHour 始终来自进程内',
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
      inputTokens: 1,
      outputTokens: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const merged = await getStatsSnapshot();
    assertEquals(merged.recent.length, 1, 'recent 条数');
    assertEquals(merged.recent[0].model, 'm', 'recent 模型');
    assertEquals(merged.lastHour.requests, 1, 'lastHour 请求数');
  });
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

    await new Promise((resolve) => setTimeout(resolve, 200));

    const merged = await getStatsSnapshot();
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
