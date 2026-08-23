/**
 * Sider 调用运行遥测（Node/Bun 侧）。
 *
 * 与 Deno 侧 `sider-telemetry.ts` 同 API，但 Node 运行时没有 Deno KV，遥测
 * 无处可存，故全部退化为 no-op。两侧的核心路由逻辑保持对称，差异仅在这层持久化。
 */

import type { SiderStrategy } from '../config/backends';

export interface SiderTelemetryRecord {
  ts: number;
  model: string;
  strategy: SiderStrategy;
  payloadChars: number;
  ok: boolean;
  siderCode: number;
  ms: number;
  hasTools: boolean;
  restoredToolUse: boolean;
}

/** Node 侧无 KV，遥测直接丢弃。 */
export function persistSiderTelemetry(_record: SiderTelemetryRecord): void {
  // no-op
}

/** Node 侧无 KV，恒返回空。 */
export async function readSiderTelemetry(): Promise<SiderTelemetryRecord[]> {
  return [];
}

/** 仅供测试。 */
export function resetSiderTelemetry(): void {
  // no-op
}
