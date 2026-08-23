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
