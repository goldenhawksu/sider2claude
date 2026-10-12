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
  strategy: SiderStrategy | 'controller';
  payloadChars: number;
  ok: boolean;
  siderCode: number;
  ms: number;
  hasTools: boolean;
  restoredToolUse: boolean;
  /** 主控模式的处理阶段；其他策略可不填。 */
  phase?: 'upstream' | 'context_upload' | 'tool_selection';
  /** 不含正文的语义结果分类。 */
  outcome?:
    | 'connect_retry'
    | 'upstream_error'
    | 'context_accepted'
    | 'context_unconfirmed'
    | 'tool_protocol_refused'
    | 'forced_tool_missing'
    | 'invalid_tool_intent'
    | 'tool_restored'
    | 'text_answer';
  correctionCount?: number;
  payloadUtf8Bytes?: number;
  questionMarks?: number;
  replacementCharacters?: number;
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

/**
 * 看板用：某个模型近期在 Sider 侧的表现。结构与 Deno 侧一致。
 */
export interface SiderHealthStat {
  model: string;
  attempts: number;
  ok: number;
  failed: number;
  lastCode: number;
  lastFailedAt: number;
  avgMs: number;
}

/** Node 侧无 KV，遥测没有存量可聚合，恒返回空——看板会退化为只显示进程内限流状态。 */
export async function aggregateSiderHealth(): Promise<SiderHealthStat[]> {
  return [];
}
