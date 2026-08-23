/**
 * 运行时可变的 Sider 调度策略（Node/Bun 侧）。
 *
 * 与 Deno 侧 `runtime-strategy.ts` 同 API，但无跨实例持久层——Node/Bun 运行时
 * 没有 Deno KV，且通常是单实例开发环境。策略切换只落进程内存，重启回到环境变量。
 *
 * 两侧的核心路由逻辑必须同步；这个模块的差异仅在于「多实例如何收敛」这一层，
 * Deno 用 KV，这里用单例内存，语义等价。
 */

import type { SiderStrategy } from '../config/backends';

let override: SiderStrategy | undefined;

/** 当前生效的策略：运行时覆盖（网页切换）> 环境变量兜底。同步返回。 */
export function currentSiderStrategy(fallback: SiderStrategy): SiderStrategy {
  return override ?? fallback;
}

/** 写入新策略。立即对当前进程生效。 */
export function setSiderStrategy(strategy: SiderStrategy): void {
  override = strategy;
}

/**
 * 与 Deno 侧同名的异步版，供 `/stats` 等展示路径使用。
 * Node 侧无 KV、没有冷启动窗口，同步版已是准确值，这里直接转发保持双侧 API 对称。
 */
export async function resolveSiderStrategy(fallback: SiderStrategy): Promise<SiderStrategy> {
  return override ?? fallback;
}

/** 兼容 Deno 侧的异步刷新签名；Node 侧无 KV，恒为 no-op。 */
export async function refreshStrategy(): Promise<SiderStrategy | undefined> {
  return override;
}

/** 仅供测试。 */
export function resetRuntimeStrategy(): void {
  override = undefined;
}
