/**
 * 跨实例可变的运行时配置：Sider 调度策略。
 *
 * 网页 `/stats` 上切换的策略要能在多实例 Deno Deploy 上收敛，必须存进 KV——
 * 进程内 mutate `cachedConfig` 只对处理 POST 的那个 isolate 生效，其余实例
 * （以及用户下一次刷新 /stats 可能命中到的另一个实例）仍是旧值。
 *
 * 读写形态：单 key 覆盖写（不是 sum、不是 CAS 队列）。策略是低频覆盖写，
 * 最后一次写入覆盖前一次即可，无并发语义要求，不需要 versionstamp 协调。
 *
 * 进程内做 3 秒 TTL 缓存：路由决策每轮都要读策略，同步读缓存是零开销，
 * 过期时才异步刷一次 KV。多实例最多 3 秒收敛到新值。
 */

import type { SiderStrategy } from '../config/backends.ts';

/// <reference lib="deno.unstable" />

import { getKv } from './usage-stats-kv.ts';

const STRATEGY_KEY = ['config', 'siderStrategy'];
const TTL_MS = 3_000;

/** 运行时覆盖值。优先于环境变量 `SIDER_STRATEGY`。 */
let override: SiderStrategy | undefined;
let cached: { at: number; value: SiderStrategy } | undefined;
let refreshInFlight: Promise<SiderStrategy | undefined> | undefined;

/**
 * 当前生效的策略。
 *
 * 顺序：进程内运行时覆盖（来自网页或上次从 KV 刷到的值）> 环境变量。
 * 同步返回，永不阻塞请求路径。
 */
export function currentSiderStrategy(fallback: SiderStrategy, now = Date.now()): SiderStrategy {
  if (override) return override;

  if (cached && now - cached.at < TTL_MS) {
    return cached.value;
  }

  // 缓存过期或为空：后台异步刷新，本轮先按已缓存/环境变量值跑，不阻塞。
  // 必须让「过期」也触发刷新——曾经只在 `!cached` 时刷新，导致缓存一旦被设置
  // 就永不更新：实例 A 网页切到 max 后写 KV，实例 B 却因早期缓存过 conservative
  // 而永久停在 conservative，多实例策略分叉（实测同一时刻 /health 与 / 返回不同策略）。
  // refreshInFlight 会去重并发刷新，最多每 TTL 触发一次 KV 读，开销可接受。
  void refreshStrategy(now);
  return cached?.value ?? fallback;
}

/**
 * 当前生效的策略，**等 KV 读回来再返回**。供 `/stats` 这类展示路径使用。
 *
 * 与同步版的分工：路由热路径每个请求都要读策略，绝不能为此阻塞，宁可用稍旧的值；
 * 而展示路径一旦显示错的策略，用户看到的就是「刚切完又跳回 Conservative」——
 * 这种错比慢几十毫秒严重得多。
 *
 * 修的是同步版一个绕不开的窗口：冷实例（刚被 Deploy 拉起、或缓存已回收）第一次
 * 被调用时 KV 还没读回来，只能返回 fallback（环境变量）。多实例下 `/stats` 每 5 秒
 * 自动刷新会随机命中这类冷实例，页面就会周期性跳回默认档。
 */
export async function resolveSiderStrategy(
  fallback: SiderStrategy,
  now = Date.now(),
): Promise<SiderStrategy> {
  if (override) return override;

  if (cached && now - cached.at < TTL_MS) {
    return cached.value;
  }

  await refreshStrategy(now);
  return cached?.value ?? fallback;
}

/** 强制刷新（也用于测试推进）。 */
export async function refreshStrategy(now = Date.now()): Promise<SiderStrategy | undefined> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const kv = await getKv();
    if (!kv) return override;
    try {
      const entry = await kv.get<{ strategy: SiderStrategy }>(STRATEGY_KEY);
      const value = entry.value?.strategy;
      if (value === 'conservative' || value === 'pro' || value === 'max') {
        cached = { at: now, value };
      }
    } catch {
      // 静默：KV 抖动时沿用现有值，策略配置永远不该拖垮路由。
    }
    return override ?? cached?.value;
  })().finally(() => {
    refreshInFlight = undefined;
  });
  return refreshInFlight;
}

/**
 * 写入新策略：同时更新进程内 override 与 KV（fire-and-forget）。
 *
 * override 立即对当前实例生效；KV 写入让其它实例在最多 3 秒后跟随。
 * 若 KV 写入失败，至少当前实例仍生效——策略切换不该因为统计层不可用而整体失败。
 */
export function setSiderStrategy(strategy: SiderStrategy): void {
  override = strategy;
  cached = { at: Date.now(), value: strategy };

  void (async () => {
    const kv = await getKv();
    if (!kv) return;
    await kv.set(STRATEGY_KEY, { strategy, at: Date.now() }).catch(() => {});
  })();
}

/** 仅供测试。 */
export function resetRuntimeStrategy(): void {
  override = undefined;
  cached = undefined;
  refreshInFlight = undefined;
}
