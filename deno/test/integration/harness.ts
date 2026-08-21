// deno-lint-ignore-file no-explicit-any -- 集成测试要读取形状不固定的上游 JSON，any 是恰当选择。
/**
 * 集成测试运行骨架：HTTP 客户端、断言、SSE 解析、结果收集与报告生成。
 *
 * 与 `deno/test/*.test.ts` 的确定性单测不同，这里打的是真实实例与真实上游，
 * 因此显式区分三种结果：
 * - pass     本服务行为符合预期
 * - fail     本服务的格式/路由/错误处理有问题
 * - upstream 上游（Sider 配额、超时等）导致无法判定，不计入失败
 * 这条区分来自 CLAUDE.md：真实外部集成测试要把"外部服务行为"与"本服务错误"分开。
 */

import { getConfig, type IntegrationConfig } from './config.ts';

export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssertionError';
  }
}

/** 上游受限：本服务表现正确，但外部依赖不可用，无法完成断言。 */
export class UpstreamLimited extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamLimited';
  }
}

// ── 断言 ──

export function assertEquals<T>(actual: T, expected: T, what = '值'): void {
  if (actual !== expected) {
    throw new AssertionError(`${what}：期望 ${String(expected)}，实际 ${String(actual)}`);
  }
}

export function assertTrue(condition: boolean, what: string): void {
  if (!condition) {
    throw new AssertionError(`期望成立：${what}`);
  }
}

/** 断言值存在并让 TypeScript 收窄类型，供 `.find()` 结果后续取字段使用。 */
export function assertDefined<T>(
  value: T | null | undefined,
  what: string,
): asserts value is T {
  if (value === null || value === undefined) {
    throw new AssertionError(`期望存在：${what}`);
  }
}

export function assertIncludes(haystack: string, needle: string, what = '文本'): void {
  if (!haystack.includes(needle)) {
    throw new AssertionError(`${what} 期望包含 "${needle}"，实际：${brief(haystack, 160)}`);
  }
}

export function assertStatus(res: { status: number; text: string }, expected: number): void {
  if (res.status !== expected) {
    throw new AssertionError(`期望 HTTP ${expected}，实际 ${res.status}：${brief(res.text, 160)}`);
  }
}

export function brief(text: string, n = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n) + '…' : flat;
}

// ── HTTP / SSE 客户端 ──

export interface JsonResult {
  status: number;
  ok: boolean;
  text: string;
  json: any;
  ms: number;
  headers: Headers;
}

export interface SseResult {
  status: number;
  ok: boolean;
  raw: string;
  /** `event:` 行的名字，按出现顺序。 */
  eventNames: string[];
  /** `data:` 行解析出的事件对象。 */
  events: Array<Record<string, any>>;
  /** `event:` 行与 `data:` 行是否一一配对（Anthropic SSE 要求成对出现）。 */
  paired: boolean;
  /** 拼接后的 text_delta 内容。 */
  text: string;
  ms: number;
}

export class ApiClient {
  constructor(private config: IntegrationConfig) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-api-key': this.config.authToken,
      'anthropic-version': '2023-06-01',
      ...extra,
    };
  }

  async json(
    method: string,
    path: string,
    body?: unknown,
    headerOverride?: Record<string, string>,
  ): Promise<JsonResult> {
    const started = Date.now();
    const res = await fetch(this.config.baseUrl + path, {
      method,
      headers: headerOverride ?? this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    return {
      status: res.status,
      ok: res.ok,
      text,
      json: parsed,
      ms: Date.now() - started,
      headers: res.headers,
    };
  }

  get(path: string, headerOverride?: Record<string, string>) {
    return this.json('GET', path, undefined, headerOverride);
  }

  post(path: string, body: unknown, headerOverride?: Record<string, string>) {
    return this.json('POST', path, body, headerOverride);
  }

  /** 在默认鉴权头基础上追加自定义头（如 X-Conversation-ID）。 */
  postWith(path: string, body: unknown, extra: Record<string, string>) {
    return this.json('POST', path, body, this.headers(extra));
  }

  /** 发起流式请求并读完整个 SSE 流。 */
  async sse(path: string, body: unknown): Promise<SseResult> {
    const started = Date.now();
    const res = await fetch(this.config.baseUrl + path, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });
    const raw = await res.text();
    const parsed = parseSSE(raw);
    return { status: res.status, ok: res.ok, raw, ...parsed, ms: Date.now() - started };
  }
}

export function parseSSE(raw: string) {
  const eventNames = [...raw.matchAll(/^event: (\S+)$/gm)].map((m) => m[1]);
  const dataLines = raw.split(/\r?\n/).filter((line) => line.startsWith('data:'));
  const events: Array<Record<string, any>> = [];
  for (const line of dataLines) {
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') {
      events.push({ type: '[DONE]' });
      continue;
    }
    try {
      events.push(JSON.parse(payload));
    } catch {
      events.push({ type: '<unparsable>', raw: payload });
    }
  }
  const text = events
    .filter((e) => e.delta?.type === 'text_delta')
    .map((e) => e.delta.text)
    .join('');
  return { eventNames, events, paired: eventNames.length === dataLines.length, text };
}

// ── Anthropic 结构断言 ──

export const ANTHROPIC_STREAM_EVENTS = [
  'message_start',
  'content_block_start',
  'content_block_delta',
  'content_block_stop',
  'message_delta',
  'message_stop',
];

/** 校验一个 Anthropic Messages 非流式响应的必备结构。 */
export function assertAnthropicMessage(json: any, expectedModel?: string): void {
  assertTrue(!!json, '响应体是合法 JSON');
  assertEquals(json.type, 'message', 'type');
  assertEquals(json.role, 'assistant', 'role');
  assertTrue(Array.isArray(json.content) && json.content.length > 0, 'content 是非空数组');
  assertTrue(typeof json.id === 'string' && json.id.length > 0, 'id 非空');
  assertTrue(
    typeof json.usage?.input_tokens === 'number' &&
      typeof json.usage?.output_tokens === 'number',
    'usage 含 input_tokens/output_tokens',
  );
  if (expectedModel) {
    // 对外始终保留客户端请求的模型名，不能泄露上游真实模型。
    assertEquals(json.model, expectedModel, '对外模型名');
  }
}

export function textOf(json: any): string {
  return (json?.content ?? [])
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('');
}

export function blockTypes(json: any): string {
  return (json?.content ?? []).map((b: any) => b.type).join(',');
}

export function toolUseOf(json: any): any | undefined {
  return (json?.content ?? []).find((b: any) => b.type === 'tool_use');
}

/** 响应来自 Sider 时会带 sider_session；DeepSeek 不带。用于验证路由决策。 */
export function backendOf(json: any): 'sider' | 'deepseek' {
  return json?.sider_session ? 'sider' : 'deepseek';
}

/**
 * 上游限流探测。Sider 配额耗尽时本服务会返回 429 rate_limit_error，
 * 这是修复后的正确行为，但后续断言无法进行，转为 upstream 结果。
 */
export function bailIfUpstreamLimited(res: JsonResult, context: string): void {
  if (res.status === 429 && res.json?.error?.type === 'rate_limit_error') {
    throw new UpstreamLimited(`${context}：${brief(res.json.error.message ?? '', 120)}`);
  }
}

export function sseUpstreamLimited(res: SseResult): string | null {
  const err = res.events.find((e) => e.type === 'error');
  if (err?.error?.type === 'rate_limit_error') {
    return brief(err.error.message ?? '', 120);
  }
  return null;
}

// ── 套件定义与执行 ──

export interface TestContext {
  api: ApiClient;
  config: IntegrationConfig;
}

export interface TestCase {
  name: string;
  /** 返回值作为报告里的"实测细节"列。 */
  run: (ctx: TestContext) => Promise<string | void>;
}

export interface Suite {
  id: string;
  title: string;
  cases: TestCase[];
}

export type Outcome = 'pass' | 'fail' | 'upstream';

export interface CaseResult {
  suiteId: string;
  suiteTitle: string;
  name: string;
  outcome: Outcome;
  ms: number;
  detail: string;
}

export async function runSuite(suite: Suite, ctx: TestContext): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  console.log(`\n═══ ${suite.id} ${suite.title} ═══`);

  for (const testCase of suite.cases) {
    const started = Date.now();
    let outcome: Outcome = 'pass';
    let detail = '';

    try {
      detail = (await testCase.run(ctx)) || '';
    } catch (error) {
      if (error instanceof UpstreamLimited) {
        outcome = 'upstream';
        detail = error.message;
      } else {
        outcome = 'fail';
        detail = error instanceof Error ? error.message : String(error);
      }
    }

    const ms = Date.now() - started;
    results.push({
      suiteId: suite.id,
      suiteTitle: suite.title,
      name: testCase.name,
      outcome,
      ms,
      detail,
    });

    const mark = outcome === 'pass' ? '✓' : outcome === 'upstream' ? '~' : '✗';
    console.log(`  ${mark} ${testCase.name.padEnd(40)} ${String(ms).padStart(6)}ms  ${brief(detail, 90)}`);
  }

  return results;
}

export function createContext(): TestContext {
  const config = getConfig();
  return { api: new ApiClient(config), config };
}
