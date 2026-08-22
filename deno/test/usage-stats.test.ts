/**
 * 用量统计模块的确定性测试。
 *
 * 覆盖对外承诺的语义：后端占比、fallback 计数、工具频次、最近明细顺序，
 * 以及 1 小时滑动窗口的边界。
 */

import {
  classifyDeepSeekReason,
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

Deno.test({
  name: '用量统计：无请求时占比为 0% 而非除零',
  sanitizeResources: false,
  sanitizeOps: false,
}, () => {
  resetUsageStats();
  const snap = getUsageSnapshot();

  assertEquals(snap.totals.requests, 0, 'requests');
  assertEquals(snap.backendShare.sider, '0%', 'sider 占比');
  assertEquals(snap.backendShare.deepseek, '0%', 'deepseek 占比');
  assertEquals(snap.recent.length, 0, 'recent 条数');
  assertEquals(snap.tools.length, 0, 'tools 条数');
});

Deno.test(
  { name: '用量统计：后端计数与占比', sanitizeResources: false, sanitizeOps: false },
  () => {
    resetUsageStats();
    for (let i = 0; i < 3; i += 1) recordUsage(rec({ backend: 'sider' }));
    recordUsage(rec({ backend: 'deepseek' }));

    const snap = getUsageSnapshot();
    assertEquals(snap.totals.requests, 4, 'requests');
    assertEquals(snap.totals.sider, 3, 'sider 次数');
    assertEquals(snap.totals.deepseek, 1, 'deepseek 次数');
    assertEquals(snap.backendShare.sider, '75%', 'sider 占比');
    assertEquals(snap.backendShare.deepseek, '25%', 'deepseek 占比');
  },
);

Deno.test({
  name: '用量统计：fallback 与流式分别计数',
  sanitizeResources: false,
  sanitizeOps: false,
}, () => {
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

Deno.test({
  name: '用量统计：工具频次按次数降序，取 Top 8',
  sanitizeResources: false,
  sanitizeOps: false,
}, () => {
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

Deno.test({
  name: '用量统计：最近明细新在前，且不含消息内容',
  sanitizeResources: false,
  sanitizeOps: false,
}, () => {
  resetUsageStats();
  recordUsage(rec({ model: 'first' }));
  recordUsage(rec({ model: 'second', backend: 'deepseek', toolUses: ['Bash'] }));

  const snap = getUsageSnapshot();
  assertEquals(snap.recent[0].model, 'second', '最新的排在最前');
  assertEquals(snap.recent[1].model, 'first', '较早的排在后面');
  assertEquals(snap.recent[0].backend, 'deepseek', '后端');
  assertEquals(snap.recent[0].tools[0], 'Bash', '工具名');

  // 明细字段是白名单式的，不应混入请求体内容
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
  const actual = Object.keys(snap.recent[0]).sort();
  assertEquals(actual.join(','), allowed.sort().join(','), 'recent 字段集合');
});

Deno.test({
  name: '用量统计：最近明细只展示 10 条，但总计不受影响',
  sanitizeResources: false,
  sanitizeOps: false,
}, () => {
  resetUsageStats();
  for (let i = 0; i < 25; i += 1) recordUsage(rec({ model: `m${i}` }));

  const snap = getUsageSnapshot();
  assertEquals(snap.recent.length, 10, '展示条数');
  assertEquals(snap.recent[0].model, 'm24', '最新一条');
  assertEquals(snap.totals.requests, 25, '总计不截断');
});

Deno.test({
  name: '用量统计：缓存回放单独计数，不污染后端占比',
  sanitizeResources: false,
  sanitizeOps: false,
}, () => {
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

Deno.test({
  name: '用量统计：lastHour 只统计窗口内的请求',
  sanitizeResources: false,
  sanitizeOps: false,
}, () => {
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

Deno.test({
  name: '用量统计：token 累计到总量与各模型',
  sanitizeResources: false,
  sanitizeOps: false,
}, () => {
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

Deno.test({
  name: '用量统计：模型聚合不受 recent 条数上限影响',
  sanitizeResources: false,
  sanitizeOps: false,
}, () => {
  resetUsageStats();
  // recent 上限 200；发 210 条后前 10 条会被滚掉，但模型累计必须完整
  for (let i = 0; i < 210; i += 1) {
    recordUsage(rec({ model: 'm', inputTokens: 1, outputTokens: 1 }));
  }
  const snap = getUsageSnapshot();
  assertEquals(snap.models[0].requests, 210, '模型累计覆盖全生命周期');
  assertEquals(snap.totals.inputTokens, 210, '总量不受截断影响');
});

Deno.test({
  name: '用量统计：趋势固定 24 个桶且时间轴连续',
  sanitizeResources: false,
  sanitizeOps: false,
}, () => {
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

/**
 * DeepSeek 归因。
 *
 * 用户的实际问题："Claude Code 跑完一轮，到底 fallback 了多少次 DeepSeek"。
 * 光看 backend=deepseek 回答不了 —— 绝大多数 DeepSeek 调用是路由规则一开始
 * 就判过去的（请求带工具），根本不是 fallback。两者必须分开计数。
 */
Deno.test({
  name: '归因：Sider 完成的请求没有 DeepSeek 归因',
  sanitizeResources: false,
  sanitizeOps: false,
}, () => {
  assertEquals(
    classifyDeepSeekReason('sider', 'sider', 'rule_5_simple_chat_prefer_sider'),
    undefined,
    'sider 归因',
  );
  // 路由判给 DeepSeek 但最终由 Sider 完成（DeepSeek 失败反向兜底）同样无归因
  assertEquals(
    classifyDeepSeekReason('sider', 'deepseek', 'rule_2_claude_tools'),
    undefined,
    '反向兜底',
  );
});

Deno.test(
  { name: '归因：工具能力规则记为 tools', sanitizeResources: false, sanitizeOps: false },
  () => {
    for (
      const ruleId of [
        'rule_1_tool_result_continuity',
        'rule_2_claude_tools',
        'rule_3_mcp_tools',
      ]
    ) {
      assertEquals(classifyDeepSeekReason('deepseek', 'deepseek', ruleId), 'tools', ruleId);
    }
  },
);

Deno.test({
  name: '归因：实际后端偏离路由初判记为 fallback',
  sanitizeResources: false,
  sanitizeOps: false,
}, () => {
  // 路由判 Sider、实际由 DeepSeek 完成 = Sider 上游受限后兜底。
  // 即便 ruleId 属于工具类也必须记 fallback：偏离本身就是失败的证据。
  assertEquals(
    classifyDeepSeekReason('deepseek', 'sider', 'rule_5_simple_chat_prefer_sider'),
    'fallback',
    '简单对话兜底',
  );
  assertEquals(
    classifyDeepSeekReason('deepseek', 'sider', 'rule_2_claude_tools'),
    'fallback',
    '偏离优先于规则',
  );
});

Deno.test({
  name: '归因：其余主动选择 DeepSeek 的规则记为 routing',
  sanitizeResources: false,
  sanitizeOps: false,
}, () => {
  for (
    const ruleId of [
      'rule_5_long_form_generation',
      'rule_5_simple_chat_deepseek',
      'rule_6_default_deepseek',
    ]
  ) {
    assertEquals(classifyDeepSeekReason('deepseek', 'deepseek', ruleId), 'routing', ruleId);
  }
});

Deno.test({
  name: '归因：按模型与总量分别累计，三分项之和等于 deepseek',
  sanitizeResources: false,
  sanitizeOps: false,
}, () => {
  resetUsageStats();
  const opus = (reason: UsageRecord['deepseekReason']) =>
    rec({ model: 'claude-opus-4.6', backend: 'deepseek', deepseekReason: reason });

  recordUsage(opus('tools'));
  recordUsage(opus('tools'));
  recordUsage(opus('fallback'));
  recordUsage(opus('routing'));
  recordUsage(rec({ model: 'claude-opus-4.6', backend: 'sider' }));
  recordUsage(rec({ model: 'claude-haiku-4.5', backend: 'deepseek', deepseekReason: 'tools' }));

  const snap = getUsageSnapshot();
  const model = snap.models.find((m) => m.model === 'claude-opus-4.6')!;
  assertEquals(model.requests, 5, 'opus 请求数');
  assertEquals(model.sider, 1, 'opus 走 sider');
  assertEquals(model.deepseek, 4, 'opus 走 deepseek');
  assertEquals(model.deepseekTools, 2, 'opus 工具归因');
  assertEquals(model.deepseekFallback, 1, 'opus 受限兜底归因');
  assertEquals(model.deepseekRouting, 1, 'opus 策略归因');
  // 不变式：三个分项必须能加回 deepseek，否则表格会漏计
  assertEquals(
    model.deepseekTools + model.deepseekFallback + model.deepseekRouting,
    model.deepseek,
    'opus 分项求和',
  );

  assertEquals(snap.totals.deepseekTools, 3, '总量工具归因');
  assertEquals(snap.totals.deepseekFallback, 1, '总量受限兜底归因');
  assertEquals(snap.totals.deepseekRouting, 1, '总量策略归因');
  assertEquals(
    snap.totals.deepseekTools + snap.totals.deepseekFallback + snap.totals.deepseekRouting,
    snap.totals.deepseek,
    '总量分项求和',
  );
});

Deno.test({
  name: '归因：sider 请求在 recent 里显式为 null 而非缺字段',
  sanitizeResources: false,
  sanitizeOps: false,
}, () => {
  resetUsageStats();
  recordUsage(rec({ backend: 'sider' }));
  const snap = getUsageSnapshot();
  assertEquals(snap.recent[0].reason, null, 'sider 归因');
});

/**
 * 趋势分桶。
 *
 * 曾经 buildTrend 的数据源是 recent（200 条上限），高流量下早期桶被静默截断。
 * 失真是单向的（越早掉得越狠），图会长成"什么都刚刚发生"的假曲棍球棒——
 * 形状比绝对值先坏掉，而形状正是趋势图的全部意义。
 */
Deno.test({
  name: '趋势：按桶独立累计，不是逐桶累加的累计曲线',
  sanitizeResources: false,
  sanitizeOps: false,
}, () => {
  resetUsageStats();
  const realNow = Date.now;
  const base = realNow();
  try {
    // 连续 5 个小时，每小时 3 条 × 100 输入 token
    for (const hoursAgo of [5, 4, 3, 2, 1]) {
      Date.now = () => base - hoursAgo * 3600_000;
      for (let i = 0; i < 3; i += 1) {
        recordUsage(rec({ inputTokens: 100, outputTokens: 10 }));
      }
    }
  } finally {
    Date.now = realNow;
  }

  const snap = getUsageSnapshot(base);
  const window = snap.trend.slice(-6, -1); // 5 小时前 .. 1 小时前
  for (const bucket of window) {
    assertEquals(bucket.requests, 3, '每桶请求数');
    assertEquals(bucket.inputTokens, 300, '每桶输入 token');
  }
  // 若是累计曲线，末桶会是 1500 而非 300
  assertEquals(window[window.length - 1].inputTokens, 300, '末桶不应是累计值');
  assertEquals(snap.totals.inputTokens, 1500, '总量仍是全量');
});

Deno.test({
  name: '趋势：超过 recent 上限后早期桶不被截断（关键回归）',
  sanitizeResources: false,
  sanitizeOps: false,
}, () => {
  resetUsageStats();
  const realNow = Date.now;
  const base = realNow();
  try {
    // recent 上限 200；这里共 300 条，分两个小时各 150 条
    for (const hoursAgo of [3, 2]) {
      Date.now = () => base - hoursAgo * 3600_000;
      for (let i = 0; i < 150; i += 1) {
        recordUsage(rec({ inputTokens: 100, outputTokens: 0 }));
      }
    }
  } finally {
    Date.now = realNow;
  }

  const snap = getUsageSnapshot(base);
  const threeHoursAgo = snap.trend[snap.trend.length - 4];
  assertEquals(threeHoursAgo.requests, 150, '最早的桶不被 recent 上限截断');
  assertEquals(threeHoursAgo.inputTokens, 15000, '最早的桶 token');

  // 趋势各桶求和必须等于总量，否则图和数对不上
  const summed = snap.trend.reduce((acc, b) => acc + b.inputTokens, 0);
  assertEquals(summed, snap.totals.inputTokens, '趋势求和 == 总量');
});

Deno.test({
  name: '趋势：滑出 24 小时窗口的桶被淘汰，不无限累积',
  sanitizeResources: false,
  sanitizeOps: false,
}, () => {
  resetUsageStats();
  const realNow = Date.now;
  const base = realNow();
  try {
    Date.now = () => base - 30 * 3600_000; // 30 小时前，早已滑出窗口
    recordUsage(rec({ inputTokens: 999 }));
    Date.now = () => base;
    recordUsage(rec({ inputTokens: 1 }));
  } finally {
    Date.now = realNow;
  }

  const snap = getUsageSnapshot(base);
  assertEquals(snap.trend.length, 24, '桶数恒定');
  const summed = snap.trend.reduce((acc, b) => acc + b.inputTokens, 0);
  assertEquals(summed, 1, '窗口外的旧数据不出现在趋势里');
  // 但总量是全生命周期的，不受窗口影响
  assertEquals(snap.totals.inputTokens, 1000, '总量保留全部');
});
