/**
 * 探测 Sider 典型 Claude 模型的服务端事件能力。
 *
 * 用法：
 *   deno task probe:sider
 *
 * 可选环境变量：
 *   SIDER_PROBE_MODEL=claude-4.5-sonnet
 *   SIDER_PROBE_CASES=simple_chat,sider_native_search,anthropic_tool_shape
 *   SIDER_PROBE_CASE_TIMEOUT_MS=25000
 *   SIDER_PROBE_OUTPUT=sider-capability-probe-results.json
 */

import { getEnv } from '../src/utils/env.ts';
import { getAllModels, mapModelName } from '../src/config/models.ts';

type ProbeCaseName = 'simple_chat' | 'sider_native_search' | 'anthropic_tool_shape';

interface SiderProbeEvent {
  type: string;
  model?: string;
  raw: unknown;
}

interface ProbeCaseResult {
  name: ProbeCaseName;
  requestedModel: string;
  siderModel: string;
  ok: boolean;
  status: string;
  eventTypes: string[];
  eventModel?: string;
  textPreview: string;
  elapsedMs: number;
  timedOut: boolean;
  error?: string;
}

interface ProbeReport {
  generatedAt: string;
  apiUrl: string;
  modelsTested: number;
  defaultDeepSeekToolModel: string;
  conclusion: {
    providesTextChat: boolean;
    providesReasoningEvents: boolean;
    providesSiderNativeToolEvents: boolean;
    providesAnthropicToolUseBlocks: boolean;
    recommendedRouting: string;
  };
  cases: ProbeCaseResult[];
  modelSummary: Array<{
    alias: string;
    siderModel: string;
    ok: boolean;
    eventTypes: string[];
    error?: string;
  }>;
}

const apiUrl = getEnv('SIDER_API_URL', 'https://sider.ai/api/chat/v1/completions');
const authToken = getEnv('SIDER_AUTH_TOKEN');
const modelFilter = getEnv('SIDER_PROBE_MODEL');
const caseFilter = new Set(
  getEnv('SIDER_PROBE_CASES')
    .split(',')
    .map((value) => value.trim())
    .filter((value): value is ProbeCaseName =>
      value === 'simple_chat' || value === 'sider_native_search' || value === 'anthropic_tool_shape'
    ),
);
const outputPath = getEnv('SIDER_PROBE_OUTPUT', 'sider-capability-probe-results.json');
const defaultDeepSeekToolModel = getEnv('DEEPSEEK_MODEL', 'deepseek-v4-flash');
const caseTimeoutMs = parsePositiveInt(getEnv('SIDER_PROBE_CASE_TIMEOUT_MS'), 25_000);
const includeSiderModelAliases = getEnv('SIDER_PROBE_INCLUDE_ALIASES') === 'true';

if (!authToken) {
  console.error(
    '缺少 SIDER_AUTH_TOKEN，无法探测 Sider 服务端能力。请在根目录 .env 或运行环境中配置。',
  );
  Deno.exit(1);
}

const results: ProbeCaseResult[] = [];
const aliases = getAllModels()
  .filter((modelInfo) =>
    !modelFilter ||
    modelInfo.id === modelFilter ||
    (includeSiderModelAliases && modelInfo.siderModel === modelFilter)
  );

if (aliases.length === 0) {
  console.error(`没有找到要探测的模型: ${modelFilter}`);
  Deno.exit(1);
}

for (const modelInfo of aliases) {
  const siderModel = modelInfo.siderModel || mapModelName(modelInfo.id);
  const cases = buildProbeCases(siderModel);

  for (const probeCase of cases) {
    if (caseFilter.size > 0 && !caseFilter.has(probeCase.name)) {
      continue;
    }

    console.log(`开始探测: ${probeCase.name} alias=${modelInfo.id} sider=${siderModel}`);
    results.push(await runProbeCase(modelInfo.id, siderModel, probeCase.name, probeCase.request));
    await writeReport(results, aliases);
  }
}

const report = buildReport(results, aliases);
await Deno.writeTextFile(outputPath, JSON.stringify(report, null, 2));
console.log(`探测完成，结果已写入 ${outputPath}`);
console.log(JSON.stringify(report.conclusion, null, 2));

function buildReport(
  currentResults: ProbeCaseResult[],
  currentAliases: ReturnType<typeof getAllModels>,
): ProbeReport {
  const allEventTypes = new Set(currentResults.flatMap((result) => result.eventTypes));
  const modelSummary = currentAliases.map((modelInfo) => {
    const siderModel = modelInfo.siderModel || mapModelName(modelInfo.id);
    const modelResults = currentResults.filter((result) => result.requestedModel === modelInfo.id);
    const eventTypes = [...new Set(modelResults.flatMap((result) => result.eventTypes))];
    const failed = modelResults.find((result) =>
      !result.ok || result.eventTypes.some((type) => type.startsWith('error_'))
    );

    return {
      alias: modelInfo.id,
      siderModel,
      ok: modelResults.some((result) =>
        result.ok &&
        (result.eventTypes.includes('text') || result.eventTypes.includes('reasoning_content'))
      ),
      eventTypes,
      ...(failed?.error ? { error: failed.error } : {}),
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    apiUrl,
    modelsTested: currentAliases.length,
    defaultDeepSeekToolModel,
    conclusion: {
      providesTextChat: allEventTypes.has('text') || allEventTypes.has('reasoning_content'),
      providesReasoningEvents: allEventTypes.has('reasoning_content'),
      providesSiderNativeToolEvents: [...allEventTypes].some((type) =>
        type.startsWith('tool_call')
      ),
      providesAnthropicToolUseBlocks: allEventTypes.has('tool_use'),
      recommendedRouting:
        `主模型对话走 Sider；Anthropic tool_use/Claude Code/MCP 工具能力走 DeepSeek ${defaultDeepSeekToolModel}。`,
    },
    cases: currentResults,
    modelSummary,
  };
}

async function writeReport(
  currentResults: ProbeCaseResult[],
  currentAliases: ReturnType<typeof getAllModels>,
) {
  const report = buildReport(currentResults, currentAliases);
  await Deno.writeTextFile(outputPath, JSON.stringify(report, null, 2));
}

function buildProbeCases(
  siderModel: string,
): Array<{ name: ProbeCaseName; request: Record<string, unknown> }> {
  return [
    {
      name: 'simple_chat',
      request: buildSiderRequest(siderModel, '请只回复 OK，用于能力探测。', { auto: [] }),
    },
    {
      name: 'sider_native_search',
      request: buildSiderRequest(siderModel, '请搜索 Sider AI 官方网站并用一句话回答。', {
        auto: ['search'],
        search: { enabled: true, max_results: 3 },
      }),
    },
    {
      name: 'anthropic_tool_shape',
      request: buildSiderRequest(
        siderModel,
        '如果你支持 Anthropic tool_use 内容块，请只返回一个 tool_use；否则请回复 NO_TOOL_USE。',
        { auto: [] },
      ),
    },
  ];
}

function buildSiderRequest(siderModel: string, text: string, tools: Record<string, unknown>) {
  return {
    cid: '',
    model: siderModel,
    from: 'chat',
    filter_search_history: false,
    chat_models: [],
    quote: null,
    multi_content: [{
      type: 'text',
      text,
      user_input_text: text,
    }],
    prompt_templates: [],
    tools,
    extra_info: {
      origin_url:
        'chrome-extension://dhoenijjpgpeimemopealfcbiecgceod/standalone.html?from=sidebar',
      origin_title: 'Sider',
    },
    output_language: 'zh-CN',
  };
}

async function runProbeCase(
  requestedModel: string,
  siderModel: string,
  name: ProbeCaseName,
  request: Record<string, unknown>,
): Promise<ProbeCaseResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), caseTimeoutMs);

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
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        name,
        requestedModel,
        siderModel,
        ok: false,
        status: `${response.status} ${response.statusText}`,
        eventTypes: [],
        textPreview: '',
        elapsedMs: Date.now() - startedAt,
        timedOut: false,
        error: await response.text(),
      };
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/event-stream')) {
      return {
        name,
        requestedModel,
        siderModel,
        ok: false,
        status: `${response.status} ${response.statusText}`,
        eventTypes: [],
        textPreview: '',
        elapsedMs: Date.now() - startedAt,
        timedOut: false,
        error: `非 SSE 响应: ${contentType}`,
      };
    }

    const events = await parseSiderEvents(response, startedAt + caseTimeoutMs);
    const eventTypes = [...new Set(events.map((event) => event.type))];
    const textPreview = events
      .map((event) => extractText(event.raw))
      .filter((text) => text.length > 0)
      .join('')
      .substring(0, 300);

    return {
      name,
      requestedModel,
      siderModel,
      ok: true,
      status: `${response.status} ${response.statusText}`,
      eventTypes,
      eventModel: events.find((event) => event.model)?.model,
      textPreview,
      elapsedMs: Date.now() - startedAt,
      timedOut: Date.now() - startedAt >= caseTimeoutMs,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name,
      requestedModel,
      siderModel,
      ok: false,
      status: message.includes('aborted') || error instanceof DOMException ? 'timeout' : 'error',
      eventTypes: [],
      textPreview: '',
      elapsedMs: Date.now() - startedAt,
      timedOut: message.includes('aborted') || error instanceof DOMException,
      error: message,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function parseSiderEvents(
  response: Response,
  deadlineMs: number,
): Promise<SiderProbeEvent[]> {
  const reader = response.body?.getReader();
  if (!reader) {
    return [];
  }

  const decoder = new TextDecoder();
  const events: SiderProbeEvent[] = [];
  let buffer = '';

  try {
    while (true) {
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) {
        break;
      }

      const readResult = await readWithTimeout(reader, remainingMs);
      if (!readResult) {
        break;
      }

      const { done, value } = readResult;
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        processSseLine(line.trim(), events);
      }
    }

    if (buffer.trim()) {
      processSseLine(buffer.trim(), events);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // 流可能已经自然结束，忽略即可。
    }
    reader.releaseLock();
  }

  return events;
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array> | undefined> {
  let timeoutId: number | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timeoutId = setTimeout(() => resolve(undefined), timeoutMs);
  });

  try {
    return await Promise.race([reader.read(), timeout]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

function processSseLine(line: string, events: SiderProbeEvent[]) {
  if (!line.startsWith('data:')) {
    return;
  }

  const payload = line.substring(5).trim();
  if (!payload || payload === '[DONE]') {
    return;
  }

  try {
    const parsed = JSON.parse(payload) as {
      code?: number;
      msg?: string;
      data?: { type?: string; model?: string };
    };

    if (parsed.code !== 0) {
      events.push({
        type: `error_${parsed.code ?? 'unknown'}`,
        raw: parsed,
      });
      return;
    }

    if (parsed.data?.type) {
      events.push({
        type: parsed.data.type,
        model: parsed.data.model,
        raw: parsed,
      });
    }
  } catch {
    events.push({
      type: 'unparseable',
      raw: payload,
    });
  }
}

function extractText(raw: unknown): string {
  if (!raw || typeof raw !== 'object') {
    return '';
  }

  const data = (raw as { data?: { text?: unknown; reasoning_content?: { text?: unknown } } }).data;
  if (typeof data?.text === 'string') {
    return data.text;
  }

  if (typeof data?.reasoning_content?.text === 'string') {
    return data.reasoning_content.text;
  }

  return '';
}

function parsePositiveInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
