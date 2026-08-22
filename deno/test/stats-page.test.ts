/**
 * stats 页面渲染的确定性测试。
 *
 * 重点是时间展示：看板面向中国用户，时间戳一律按 UTC+8（北京/上海）渲染。
 * 服务实际跑在 Deno Deploy 上（进程时区为 UTC），因此绝不能依赖
 * `Date#getHours()` 这类本地时区方法，否则页面会比北京时间晚 8 小时。
 *
 * 注意：开发机若本身就在 UTC+8，`getHours()` 会碰巧给出正确结果，
 * 单看渲染值无法暴露缺陷。因此下面用「构造一个偏移已知的假时区」
 * 来断言实现与运行时时区无关 —— 这是本文件里唯一真正有约束力的检查。
 */

import { renderStatsPage } from '../src/utils/stats-page.ts';
import type { UsageSnapshot } from '../src/utils/usage-stats.ts';

function assertEquals<T>(actual: T, expected: T, what = '值') {
  if (actual !== expected) {
    throw new Error(`${what}：期望 ${String(expected)}，实际 ${String(actual)}`);
  }
}

function assertIncludes(haystack: string, needle: string, what = '内容') {
  if (!haystack.includes(needle)) {
    throw new Error(`${what}：期望包含 ${needle}，但未找到`);
  }
}

function snapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    since: '2026-08-22T00:30:00.000Z',
    note: '测试快照',
    persisted: true,
    totals: {
      requests: 3,
      sider: 2,
      deepseek: 1,
      fallbacks: 0,
      streaming: 1,
      toolCalls: 1,
      cachedReplays: 0,
      inputTokens: 100,
      outputTokens: 200,
    },
    backendShare: { sider: '67%', deepseek: '33%' },
    lastHour: { requests: 1, sider: 1, deepseek: 0, fallbacks: 0 },
    tools: [{ name: 'Read', count: 1 }],
    recent: [{
      time: '2026-08-22T01:05:00.000Z',
      model: 'claude-opus-4.6',
      backend: 'deepseek',
      fallback: false,
      tools: ['Read'],
      stream: false,
      ms: 120,
      tokens: 300,
    }],
    trend: [{
      at: '2026-08-22T00:00:00.000Z',
      requests: 1,
      inputTokens: 10,
      outputTokens: 20,
      sider: 1,
      deepseek: 0,
    }],
    models: [{
      model: 'claude-opus-4.6',
      requests: 3,
      inputTokens: 100,
      outputTokens: 200,
      totalTokens: 300,
    }],
    ...overrides,
  } as UsageSnapshot;
}

Deno.test('stats 页面：最近明细时间按 UTC+8 渲染', () => {
  // 01:05 UTC -> 09:05 北京
  const html = renderStatsPage(snapshot());
  assertIncludes(html, '09:05', '最近明细时间');
});

Deno.test('stats 页面：趋势 x 轴刻度按 UTC+8 渲染', () => {
  // 00:00 UTC -> 08:00 北京
  const html = renderStatsPage(snapshot());
  assertIncludes(html, '08:00', '趋势刻度');
});

Deno.test('stats 页面：页头「自 X 起」按 UTC+8 渲染', () => {
  // 00:30 UTC -> 08:30 北京
  const html = renderStatsPage(snapshot());
  assertIncludes(html, '08:30', '页头起始时间');
});

Deno.test('stats 页面：跨零点时正确进位到次日', () => {
  // 20:15 UTC -> 次日 04:15 北京
  const html = renderStatsPage(snapshot({
    recent: [{
      time: '2026-08-22T20:15:00.000Z',
      model: 'claude-opus-4.6',
      backend: 'sider',
      fallback: false,
      tools: [],
      stream: false,
      ms: 50,
      tokens: 0,
    }],
  }) as UsageSnapshot);
  assertIncludes(html, '04:15', '跨零点时间');
});

Deno.test('stats 页面：时区不随运行时时区变化（关键回归）', () => {
  // 模拟 Deno Deploy：进程时区为 UTC，getHours() 等同 getUTCHours()。
  // 开发机在 UTC+8 时 getHours() 会碰巧正确，只有这样才能暴露缺陷。
  const RealDate = Date;
  class UtcDate extends RealDate {
    override getHours(): number {
      return this.getUTCHours();
    }
    override getMinutes(): number {
      return this.getUTCMinutes();
    }
    override getTimezoneOffset(): number {
      return 0;
    }
  }

  // deno-lint-ignore no-global-assign
  Date = UtcDate as DateConstructor;
  try {
    const html = renderStatsPage(snapshot());
    // 01:05 UTC 必须仍渲染成 09:05（北京），而不是随进程时区变成 01:05。
    assertIncludes(html, '09:05', 'UTC 运行时下的 UTC+8 时刻');
    assertEquals(html.includes('>01:05<'), false, '不应出现 UTC 原始时刻');
  } finally {
    // deno-lint-ignore no-global-assign
    Date = RealDate;
  }
});

Deno.test('stats 页面：标注时区，避免读者误读为本地时间', () => {
  const html = renderStatsPage(snapshot());
  assertIncludes(html, 'UTC+8', '时区标注');
});
