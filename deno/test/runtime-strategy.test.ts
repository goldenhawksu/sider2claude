/**
 * 运行时策略切换（`runtime-strategy.ts`）的确定性测试。
 *
 * 重点守一个生产实测过的多实例分叉回归：缓存一旦被设置就永不刷新，导致
 * 实例 A 网页切到 max 写 KV 后，实例 B 却因早期缓存过 conservative 而永久停在
 * conservative，同一时刻不同实例返回不同策略。修复后缓存过期也会触发刷新，
 * 多实例在 TTL 内收敛到 KV 里的值。
 *
 * 所有 API 接受 `now` 参数，用假时间戳推进，不用固定 `setTimeout`——
 * 固定等待随机器负载浮动，会偶发红的门禁等于没有门禁。
 */

import {
  currentSiderStrategy,
  refreshStrategy,
  resetRuntimeStrategy,
  resolveSiderStrategy,
} from '../src/utils/runtime-strategy.ts';
import { closeStatsKv, getKv } from '../src/utils/usage-stats-kv.ts';

function assertEquals<T>(actual: T, expected: T, what = '值') {
  if (actual !== expected) {
    throw new Error(`${what}：期望 ${String(expected)}，实际 ${String(actual)}`);
  }
}

async function withMemoryKv(fn: () => Promise<void>): Promise<void> {
  const prev = Deno.env.get('STATS_KV');
  Deno.env.set('STATS_KV', 'memory');
  await closeStatsKv();
  try {
    await fn();
  } finally {
    await closeStatsKv();
    if (prev === undefined) Deno.env.delete('STATS_KV');
    else Deno.env.set('STATS_KV', prev);
  }
}

async function waitFor(ready: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const KEY = ['config', 'siderStrategy'];
const T0 = 1_700_000_000_000;

Deno.test({
  name: 'runtime-strategy：缓存过期后重新从 KV 读新策略（守多实例分叉回归）',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withMemoryKv(async () => {
      resetRuntimeStrategy();
      const kv = await getKv();
      assertEquals(kv !== null, true, 'KV 可用');

      // 缓存先读到 KV 里的 conservative
      await kv!.set(KEY, { strategy: 'conservative', at: T0 });
      await refreshStrategy(T0);
      assertEquals(currentSiderStrategy('pro', T0), 'conservative', '首次刷新读到 KV 值');

      // 另一个实例网页切到 max，写 KV
      await kv!.set(KEY, { strategy: 'max', at: T0 });

      // TTL 内仍用旧缓存，不触发读
      assertEquals(currentSiderStrategy('pro', T0 + 1_000), 'conservative', 'TTL 内仍用旧值');

      // 缓存过期（3 秒后）：当轮仍返回旧值，但已后台触发刷新
      assertEquals(currentSiderStrategy('pro', T0 + 4_000), 'conservative', '过期当轮返回旧值');

      // 刷新完成后，读到 KV 里的 max —— 这是修复前会永久停在 conservative 的地方
      await waitFor(() => currentSiderStrategy('pro', T0 + 5_000) === 'max');
      assertEquals(currentSiderStrategy('pro', T0 + 5_000), 'max', '过期刷新后读到新值');
    });
  },
});

Deno.test({
  name: 'runtime-strategy：无 KV 覆盖时回退环境变量兜底',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withMemoryKv(async () => {
      resetRuntimeStrategy();
      // KV 为空：refreshStrategy 不更新 cached，currentSiderStrategy 用 fallback
      await refreshStrategy(T0);
      assertEquals(currentSiderStrategy('pro', T0), 'pro', 'KV 空时回退环境变量兜底');
      assertEquals(currentSiderStrategy('conservative', T0), 'conservative', '兜底值可任意传入');
    });
  },
});

/**
 * 冷实例窗口：这是 `/stats` 页面「自动刷新后跳回 Conservative」的真凶。
 *
 * 同步版 currentSiderStrategy 在缓存为空时只能 fire-and-forget 触发刷新、
 * 本轮返回环境变量兜底值。多实例下 /stats 每 5 秒刷新会随机命中刚拉起的冷实例，
 * 页面就周期性跳回默认档；用户手动刷新时若命中热实例又是对的，于是看起来
 * 像「自动刷新会重置策略」。展示路径必须用 resolveSiderStrategy 等 KV 读回来。
 */
Deno.test({
  name: 'runtime-strategy：冷实例下异步版等到 KV 真值，同步版才会先吐兜底值',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withMemoryKv(async () => {
      resetRuntimeStrategy();
      const kv = await getKv();
      await kv!.set(KEY, { strategy: 'pro', at: T0 });

      // 冷实例：缓存为空。同步版拿不到 KV 值，只能返回兜底——这就是页面看到的错值
      resetRuntimeStrategy();
      assertEquals(
        currentSiderStrategy('conservative', T0),
        'conservative',
        '同步版在冷实例上返回兜底值（问题现象）',
      );

      // 异步版在同样的冷实例上必须拿到 KV 里的真值
      resetRuntimeStrategy();
      assertEquals(
        await resolveSiderStrategy('conservative', T0),
        'pro',
        '异步版等到 KV 真值（修复）',
      );
    });
  },
});
