/**
 * Sider probe 的共用客户端。
 *
 * 为什么要单独抽出来：Sider 有约 6 次/分钟的速率限制（超出返回 code 1135）。
 * 不做节流的话，probe 测出来的是**吞吐**而不是**能力**——第一次跑端到端
 * 探测时就被 1135 打断过，结果里混进了与能力无关的失败。
 *
 * 因此这里做两件事：
 * 1. 请求之间按 SIDER_PROBE_PACE_MS 节流（默认 12s ≈ 5 次/分钟，留余量）；
 * 2. 撞到 1135 时按上游提示冷却重试；重试仍失败则单独标记为 `throttled`，
 *    由调用方从合规率分母里剔除——限速不是能力缺陷，不该拉低能力读数。
 */

import { getEnv } from '../src/utils/env.ts';

export function numEnv(name: string, fallback: number): number {
  const raw = (getEnv(name) ?? '').trim();
  const value = Number(raw);
  return raw && Number.isFinite(value) && value > 0 ? value : fallback;
}

export const authToken = getEnv('SIDER_AUTH_TOKEN') ?? '';
export const apiUrl = getEnv('SIDER_API_URL') ?? 'https://sider.ai/api/chat/v1/completions';
export const probeModel = (getEnv('SIDER_PROBE_TOOL_MODEL') || 'claude-sonnet-5').trim();
export const timeoutMs = numEnv('SIDER_PROBE_CASE_TIMEOUT_MS', 90_000);
/** 请求间隔。实测约 6 次/分钟触发 1135，这里默认留一次余量。 */
const paceMs = numEnv('SIDER_PROBE_PACE_MS', 12_000);
/** 撞到 1135 后的冷却时长。上游提示 "try again after 1 minutes"。 */
const cooldownMs = numEnv('SIDER_PROBE_COOLDOWN_MS', 65_000);
const maxRetries = numEnv('SIDER_PROBE_MAX_RETRIES', 2);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface AskResult {
  kind: 'ok' | 'throttled' | 'rejected' | 'error';
  text: string;
  cid: string;
  assistant: string;
  detail: string;
  bytes: number;
  ms: number;
}

let lastRequestAt = 0;

function buildBody(text: string, cid: string, parent: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    cid,
    model: probeModel,
    from: 'chat',
    filter_search_history: false,
    chat_models: [],
    quote: null,
    multi_content: [{ type: 'text', text, user_input_text: text }],
    prompt_templates: [],
    tools: { auto: [] },
    extra_info: {
      origin_url:
        'chrome-extension://dhoenijjpgpeimemopealfcbiecgceod/standalone.html?from=sidebar',
      origin_title: 'Sider',
    },
    output_language: 'zh-CN',
  };
  if (parent) body.parent_message_id = parent;
  return body;
}

async function sendOnce(text: string, cid: string, parent: string): Promise<AskResult> {
  const body = buildBody(text, cid, parent);
  const bytes = JSON.stringify(body).length;
  const started = Date.now();

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
        'Origin': 'chrome-extension://dhoenijjpgpeimemopealfcbiecgceod',
        'User-Agent': 'Mozilla/5.0 Sider2Claude Capability Probe',
        'X-Time-Zone': 'Asia/Shanghai',
        'X-App-Version': '5.13.0',
        'X-App-Name': 'ChitChat_Edge_Ext',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const ms = Date.now() - started;

    // HTTP 非 2xx：硬拒（如 code 603 内容过长）
    if (!response.ok) {
      const raw = await response.text();
      const matched = raw.match(/"code":(\d+),"msg":"([^"]*)"/);
      return {
        kind: 'rejected',
        text: '',
        cid: '',
        assistant: '',
        detail: `code ${matched?.[1] ?? response.status}: ${(matched?.[2] ?? raw).slice(0, 90)}`,
        bytes,
        ms,
      };
    }

    // Sider 用 HTTP 200 + SSE 内 code != 0 表达业务失败
    const raw = await response.text();
    let out = '';
    let cidOut = '';
    let assistant = '';
    let errCode = 0;
    let errMsg = '';

    for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const event = JSON.parse(payload) as {
          code?: number;
          msg?: string;
          data?: {
            type?: string;
            text?: string;
            message_start?: { cid?: string; assistant_message_id?: string };
          };
        };
        if (typeof event.code === 'number' && event.code !== 0) {
          errCode = event.code;
          errMsg = String(event.msg ?? '').slice(0, 90);
          continue;
        }
        if (event.data?.message_start) {
          cidOut = event.data.message_start.cid ?? '';
          assistant = event.data.message_start.assistant_message_id ?? '';
        }
        if (event.data?.type === 'text' && event.data.text) out += event.data.text;
      } catch {
        // 忽略无法解析的事件行
      }
    }

    // 判定保守：只有完全没拿到文本时才算失败（与生产侧口径一致）
    if (!out && errCode) {
      return {
        kind: errCode === 1135 ? 'throttled' : 'rejected',
        text: '',
        cid: '',
        assistant: '',
        detail: `code ${errCode}: ${errMsg}`,
        bytes,
        ms,
      };
    }

    return { kind: 'ok', text: out, cid: cidOut, assistant, detail: '', bytes, ms };
  } catch (error) {
    return {
      kind: 'error',
      text: '',
      cid: '',
      assistant: '',
      detail: error instanceof Error ? error.message : String(error),
      bytes,
      ms: Date.now() - started,
    };
  }
}

/** 带节流与 1135 冷却重试的请求。 */
export async function askSider(
  text: string,
  options: { cid?: string; parent?: string } = {},
): Promise<AskResult> {
  const since = Date.now() - lastRequestAt;
  if (lastRequestAt && since < paceMs) {
    await sleep(paceMs - since);
  }

  let result = await sendOnce(text, options.cid ?? '', options.parent ?? '');
  for (let attempt = 0; attempt < maxRetries && result.kind === 'throttled'; attempt += 1) {
    await sleep(cooldownMs);
    result = await sendOnce(text, options.cid ?? '', options.parent ?? '');
  }

  lastRequestAt = Date.now();
  return result;
}

/** 契约驱动的工具调用行，与 parseTextualToolUseLine 支持的第二种格式一致。 */
export const TOOL_LINE = /^\[tool_use:([^\]]+)\]\s+id=(\S+)\s+input=(\{.*\})\s*$/;

export function extractToolCall(raw: string): { name: string; input: unknown } | undefined {
  const line = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => TOOL_LINE.test(l));
  if (!line) return undefined;
  const matched = line.match(TOOL_LINE)!;
  try {
    return { name: matched[1], input: JSON.parse(matched[3]) };
  } catch {
    return undefined; // 调用行存在但 JSON 非法，交给调用方按失败计
  }
}

export function requireToken(): void {
  if (!authToken) {
    console.error('缺少 SIDER_AUTH_TOKEN，无法探测。请在根目录 .env 或运行环境中配置。');
    Deno.exit(1);
  }
}
