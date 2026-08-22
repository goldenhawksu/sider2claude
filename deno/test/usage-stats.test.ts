/**
 * 用量统计模块的确定性测试。
 *
 * 覆盖对外承诺的语义：后端占比、fallback 计数、工具频次、最近明细顺序，
 * 以及 1 小时滑动窗口的边界。
 */

import {
  getUsageSnapshot,
  recordCachedReplay,
  recordUsage,
  resetUsageStats,
  type UsageRecord,
} from '../src/utils/usage-stats.ts';

function assertEquals<T>(actual: T, expected: T, what = '值') {
  if (actual !== expected) {
    throw new Error(`${what}：期望 ${String(expected)}，实际 ${String(actual)}`);
  }
}

function rec(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    model: 'claude-haiku-4.5',
    backend: 'sider',
    fallback: false,
    toolUses: [],
    stream: false,
    ms: 100,
    inputTokens: 0,
    outputTokens: 0,
    ...overrides,
  };
}

Deno.test({ name: '用量统计：无请求时占比为 0% 而非除零', sanitizeResources: false, sanitizeOps: false }, () => {
  resetUsageStats();
  const snap = getUsageSnapshot();

  assertEquals(snap.totals.requests, 0, 'requests');
  assertEquals(snap.backendShare.sider, '0%', 'sider 占比');
  assertEquals(snap.backendShare.deepseek, '0%', 'deepseek 占比');
  assertEquals(snap.recent.length, 0, 'recent 条数');
  assertEquals(snap.tools.length, 0, 'tools 条数');
});

Deno.test({ name: '用量统计：后端计数与占比', sanitizeResources: false, sanitizeOps: false }, () => {
  resetUsageStats();
  for (let i = 0; i < 3; i += 1) recordUsage(rec({ backend: 'sider' }));
  recordUsage(rec({ backend: 'deepseek' }));

  const snap = getUsageSnapshot();
  assertEquals(snap.totals.requests, 4, 'requests');
  assertEquals(snap.totals.sider, 3, 'sider 次数');
  assertEquals(snap.totals.deepseek, 1, 'deepseek 次数');
  assertEquals(snap.backendShare.sider, '75%', 'sider 占比');
  assertEquals(snap.backendShare.deepseek, '25%', 'deepseek 占比');
});

Deno.test({ name: '用量统计：fallback 与流式分别计数', sanitizeResources: false, sanitizeOps: false }, () => {
  resetUsageStats();
  recordUsage(rec({ backend: 'deepseek', fallback: true }));
  recordUsage(rec({ backend: 'sider', stream: true }));
  recordUsage(rec({ backend: 'sider' }));

  const snap = getUsageSnapshot();
  assertEquals(snap.totals.fallbacks, 1, 'fallback 次数');
  assertEquals(snap.totals.streaming, 1, '流式次数');
  // fallback 不额外计入请求数，只是请求的一个属性
  assertEquals(snap.totals.requests, 3, 'requests');
});

Deno.test({ name: '用量统计：工具频次按次数降序，取 Top 8', sanitizeResources: false, sanitizeOps: false }, () => {
  resetUsageStats();
  recordUsage(rec({ backend: 'deepseek', toolUses: ['Bash', 'Read'] }));
  recordUsage(rec({ backend: 'deepseek', toolUses: ['Bash'] }));
  recordUsage(rec({ backend: 'deepseek', toolUses: ['Bash', 'Glob'] }));
  for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
    recordUsage(rec({ backend: 'deepseek', toolUses: [name] }));
  }

  const snap = getUsageSnapshot();
  // 前三次分别是 2 + 1 + 2 = 5 个工具，加上后面 7 个单工具请求
  assertEquals(snap.totals.toolCalls, 5 + 7, '工具调用总数');
  assertEquals(snap.tools[0].name, 'Bash', '最高频工具');
  assertEquals(snap.tools[0].count, 3, 'Bash 次数');
  assertEquals(snap.tools.length, 8, 'Top 8 截断');
});

Deno.test({ name: '用量统计：最近明细新在前，且不含消息内容', sanitizeResources: false, sanitizeOps: false }, () => {
  resetUsageStats();
  recordUsage(rec({ model: 'first' }));
  recordUsage(rec({ model: 'second', backend: 'deepseek', toolUses: ['Bash'] }));

  const snap = getUsageSnapshot();
  assertEquals(snap.recent[0].model, 'second', '最新的排在最前');
  assertEquals(snap.recent[1].model, 'first', '较早的排在后面');
  assertEquals(snap.recent[0].backend, 'deepseek', '后端');
  assertEquals(snap.recent[0].tools[0], 'Bash', '工具名');

  // 明细字段是白名单式的，不应混入请求体内容
  const allowed = ['time', 'model', 'backend', 'fallback', 'tools', 'stream', 'ms', 'tokens'];
  const actual = Object.keys(snap.recent[0]).sort();
  assertEquals(actual.join(','), allowed.sort().join(','), 'recent 字段集合');
});

Deno.test({ name: '用量统计：最近明细只展示 10 条，但总计不受影响', sanitizeResources: false, sanitizeOps: false }, () => {
  resetUsageStats();
  for (let i = 0; i < 25; i += 1) recordUsage(rec({ model: `m${i}` }));

  const snap = getUsageSnapshot();
  assertEquals(snap.recent.length, 10, '展示条数');
  assertEquals(snap.recent[0].model, 'm24', '最新一条');
  assertEquals(snap.totals.requests, 25, '总计不截断');
});

Deno.test({ name: '用量统计：缓存回放单独计数，不污染后端占比', sanitizeResources: false, sanitizeOps: false }, () => {
  resetUsageStats();
  recordUsage(rec({ backend: 'sider' }));
  recordCachedReplay();
  recordCachedReplay();

  const snap = getUsageSnapshot();
  // 回放没有触达任何上游，因此不计入 requests，也不影响占比
  assertEquals(snap.totals.requests, 1, 'requests 只算真实上游调用');
  assertEquals(snap.totals.cachedReplays, 2, '回放次数');
  assertEquals(snap.backendShare.sider, '100%', 'sider 占比不被回放稀释');
  assertEquals(snap.recent.length, 1, 'recent 不含回放');
});

Deno.test({ name: '用量统计：lastHour 只统计窗口内的请求', sanitizeResources: false, sanitizeOps: false }, () => {
  resetUsageStats();
  recordUsage(rec({ backend: 'sider' }));
  recordUsage(rec({ backend: 'deepseek', fallback: true }));

  // 把「现在」推到 2 小时后：两条都应落到窗口外
  const future = Date.now() + 2 * 60 * 60_000;
  const snap = getUsageSnapshot(future);

  assertEquals(snap.totals.requests, 2, '总计保留');
  assertEquals(snap.lastHour.requests, 0, '窗口内请求数');
  assertEquals(snap.lastHour.sider, 0, '窗口内 sider');
  assertEquals(snap.lastHour.fallbacks, 0, '窗口内 fallback');

  const now = getUsageSnapshot();
  assertEquals(now.lastHour.requests, 2, '当下窗口内请求数');
  assertEquals(now.lastHour.sider, 1, '当下窗口内 sider');
  assertEquals(now.lastHour.deepseek, 1, '当下窗口内 deepseek');
  assertEquals(now.lastHour.fallbacks, 1, '当下窗口内 fallback');
});

Deno.test({ name: '用量统计：token 累计到总量与各模型', sanitizeResources: false, sanitizeOps: false }, () => {
  resetUsageStats();
  recordUsage(rec({ model: 'claude-opus-4.6', inputTokens: 100, outputTokens: 50 }));
  recordUsage(rec({ model: 'claude-opus-4.6', inputTokens: 200, outputTokens: 30 }));
  recordUsage(rec({ model: 'claude-haiku-4.5', inputTokens: 10, outputTokens: 5 }));

  const snap = getUsageSnapshot();
  assertEquals(snap.totals.inputTokens, 310, '输入 token 总量');
  assertEquals(snap.totals.outputTokens, 85, '输出 token 总量');

  // models 按请求数降序
  assertEquals(snap.models[0].model, 'claude-opus-4.6', '首位模型');
  assertEquals(snap.models[0].requests, 2, '首位模型请求数');
  assertEquals(snap.models[0].totalTokens, 380, '首位模型 token 合计');
  assertEquals(snap.models[1].model, 'claude-haiku-4.5', '次位模型');
});

Deno.test({ name: '用量统计：模型聚合不受 recent 条数上限影响', sanitizeResources: false, sanitizeOps: false }, () => {
  resetUsageStats();
  // recent 上限 200；发 210 条后前 10 条会被滚掉，但模型累计必须完整
  for (let i = 0; i < 210; i += 1) {
    recordUsage(rec({ model: 'm', inputTokens: 1, outputTokens: 1 }));
  }
  const snap = getUsageSnapshot();
  assertEquals(snap.models[0].requests, 210, '模型累计覆盖全生命周期');
  assertEquals(snap.totals.inputTokens, 210, '总量不受截断影响');
});

Deno.test({ name: '用量统计：趋势固定 24 个桶且时间轴连续', sanitizeResources: false, sanitizeOps: false }, () => {
  resetUsageStats();
  recordUsage(rec({ inputTokens: 5, outputTokens: 5 }));

  const snap = getUsageSnapshot();
  assertEquals(snap.trend.length, 24, '桶数');

  // 最后一个桶是当前小时，应包含刚才那条记录
  const last = snap.trend[snap.trend.length - 1];
  assertEquals(last.requests, 1, '当前桶请求数');
  assertEquals(last.inputTokens, 5, '当前桶输入 token');

  // 空桶保留，保证折线不会把缺口连成斜线
  assertEquals(snap.trend[0].requests, 0, '最早的桶为空');

  // 桶按时间升序且间隔恒定为 1 小时
  const gaps = new Set<number>();
  for (let i = 1; i < snap.trend.length; i += 1) {
    gaps.add(Date.parse(snap.trend[i].at) - Date.parse(snap.trend[i - 1].at));
  }
  assertEquals(gaps.size, 1, '间隔恒定');
  assertEquals([...gaps][0], 3600_000, '间隔为 1 小时');
});
