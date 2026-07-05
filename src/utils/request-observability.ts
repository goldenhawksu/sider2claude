import type { AnthropicRequest } from '../types';

export const NON_STREAM_SLOW_MS = 10_000;
export const STREAM_FIRST_EVENT_SLOW_MS = 2_000;
export const STREAM_TOTAL_SLOW_MS = 30_000;

const DUPLICATE_WINDOW_MS = 30_000;
const MAX_RECENT_FINGERPRINTS = 256;

export interface RequestSummary {
  model: string;
  messages: number;
  tools: number;
  stream: boolean;
  hasSystem: boolean;
  requestBytes: number;
  maxTokens?: number;
  thinking?: string;
}

export interface RequestLogContext {
  requestId: string;
  requestHash: string;
  summary: RequestSummary;
}

export interface DuplicateCandidate {
  duplicate: boolean;
  count: number;
  previousStreams: boolean[];
  ageMs: number;
}

interface RecentFingerprint {
  firstSeenAt: number;
  lastSeenAt: number;
  count: number;
  streams: Set<boolean>;
  reportedStreamMismatch: boolean;
}

const recentFingerprints = new Map<string, RecentFingerprint>();

export function createRequestId(): string {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return `req_${Date.now().toString(36)}_${random}`;
}

export function summarizeAnthropicRequest(request: AnthropicRequest): RequestSummary {
  const summary: RequestSummary = {
    model: request.model,
    messages: request.messages?.length || 0,
    tools: request.tools?.length || 0,
    stream: !!request.stream,
    hasSystem: !!request.system,
    requestBytes: stableStringify(redactForFingerprint(request)).length,
  };

  if (typeof request.max_tokens === 'number') {
    summary.maxTokens = request.max_tokens;
  }

  const thinking = (request as { thinking?: { type?: string } }).thinking;
  if (thinking?.type) {
    summary.thinking = thinking.type;
  }

  return summary;
}

export function createRequestLogContext(
  request: AnthropicRequest,
  requestId = createRequestId(),
): RequestLogContext {
  return {
    requestId: sanitizeRequestId(requestId),
    requestHash: hashAnthropicRequest(request),
    summary: summarizeAnthropicRequest(request),
  };
}

export function hashAnthropicRequest(request: AnthropicRequest): string {
  return fnv1a53(stableStringify(redactForFingerprint(request)));
}

export function observeDuplicateCandidate(
  requestHash: string,
  stream: boolean,
  now = Date.now(),
): DuplicateCandidate {
  cleanupRecentFingerprints(now);

  let entry = recentFingerprints.get(requestHash);
  if (!entry) {
    entry = {
      firstSeenAt: now,
      lastSeenAt: now,
      count: 0,
      streams: new Set<boolean>(),
      reportedStreamMismatch: false,
    };
    recentFingerprints.set(requestHash, entry);
  }

  const streamMismatch = entry.streams.size > 0 && !entry.streams.has(stream);
  entry.count += 1;
  entry.lastSeenAt = now;
  entry.streams.add(stream);

  const duplicate = streamMismatch && !entry.reportedStreamMismatch;
  if (duplicate) {
    entry.reportedStreamMismatch = true;
  }

  trimRecentFingerprints();

  return {
    duplicate,
    count: entry.count,
    previousStreams: Array.from(entry.streams.values()),
    ageMs: now - entry.firstSeenAt,
  };
}

export function logInfo(
  event: string,
  fields: Record<string, unknown>,
  label = `${event}:`,
): void {
  console.info(label, buildLogPayload('info', event, fields));
}

export function logWarn(
  event: string,
  fields: Record<string, unknown>,
  label = `${event}:`,
): void {
  console.warn(label, buildLogPayload('warn', event, fields));
}

export function logError(
  event: string,
  fields: Record<string, unknown>,
  label = `${event}:`,
): void {
  console.error(label, buildLogPayload('error', event, fields));
}

export function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }

  return {
    message: String(error),
  };
}

export function resetRequestObservabilityForTests(): void {
  recentFingerprints.clear();
}

function buildLogPayload(
  level: 'info' | 'warn' | 'error',
  event: string,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  };
}

function sanitizeRequestId(requestId: string): string {
  const normalized = requestId.trim().replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 80);
  return normalized || createRequestId();
}

function cleanupRecentFingerprints(now: number): void {
  for (const [hash, entry] of recentFingerprints.entries()) {
    if (now - entry.lastSeenAt > DUPLICATE_WINDOW_MS) {
      recentFingerprints.delete(hash);
    }
  }
}

function trimRecentFingerprints(): void {
  while (recentFingerprints.size > MAX_RECENT_FINGERPRINTS) {
    const oldest = recentFingerprints.keys().next().value;
    if (!oldest) {
      return;
    }
    recentFingerprints.delete(oldest);
  }
}

function redactForFingerprint(request: AnthropicRequest): Record<string, unknown> {
  const next = { ...request } as Record<string, unknown>;
  delete next.stream;
  delete next.metadata;
  return next;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableStringify(record[key])}`
  ).join(',')}}`;
}

function fnv1a53(input: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = (hash * prime) & mask;
  }

  return hash.toString(16).padStart(16, '0');
}
