/**
 * Anthropic Messages 兼容后端适配器。
 *
 * 当前用于 DeepSeek 的 /anthropic 兼容入口。它对上游使用 DeepSeek 模型，
 * 对下游仍保持 Claude Code 请求里的 Claude 模型名。
 */

import type {
  AnthropicContent,
  AnthropicMessage,
  AnthropicRequest,
  AnthropicResponse,
  AnthropicResponseContent,
} from '../types/anthropic';
import type { AnthropicBackendConfig } from '../config/backends';
import { consola } from 'consola';
import {
  logError,
  logInfo,
  logWarn,
  NON_STREAM_SLOW_MS,
  type RequestLogContext,
} from '../utils/request-observability';

export class AnthropicBackendError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public provider: AnthropicBackendConfig['provider'],
  ) {
    super(message);
    this.name = 'AnthropicBackendError';
  }
}

export class AnthropicApiAdapter {
  private baseUrl: string;
  private apiKey: string;
  private upstreamModel: string;
  private provider: AnthropicBackendConfig['provider'];

  constructor(config: AnthropicBackendConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.upstreamModel = config.model;
    this.provider = config.provider;
  }

  async sendRequest(
    request: AnthropicRequest,
    logContext?: RequestLogContext,
  ): Promise<AnthropicResponse> {
    const startTime = Date.now();
    const outwardModel = request.model;
    const upstreamRequest = this.buildUpstreamRequest(request);

    logInfo('upstream_request', {
      ...this.contextFields(logContext),
      provider: this.provider,
      upstreamModel: upstreamRequest.model,
      outwardModel,
      messages: upstreamRequest.messages.length,
      tools: upstreamRequest.tools?.length || 0,
      requestedStream: !!request.stream,
    }, 'Forwarding Anthropic-compatible request:');

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(upstreamRequest),
    });

    if (!response.ok) {
      const errorText = await response.text();
      const elapsed = Date.now() - startTime;
      logError('upstream_error', {
        ...this.contextFields(logContext),
        provider: this.provider,
        status: response.status,
        statusText: response.statusText,
        preview: errorText.substring(0, 300),
        elapsed: `${elapsed}ms`,
        elapsedMs: elapsed,
      }, 'Anthropic-compatible backend error:');
      throw new AnthropicBackendError(
        `${this.provider} API error: ${response.status} ${response.statusText}`,
        response.status,
        this.provider,
      );
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const responseText = await response.text();
      throw new Error(
        `${this.provider} API returned non-JSON response: ${contentType || 'unknown'} ${
          responseText.substring(0, 120)
        }`,
      );
    }

    const data = await response.json() as unknown;
    const normalized = this.normalizeResponse(
      data,
      outwardModel,
      logContext,
      collectHistoryToolUseIds(request.messages),
      collectToolInputKeys(request.tools),
    );
    const elapsed = Date.now() - startTime;

    logInfo('upstream_response', {
      ...this.contextFields(logContext),
      provider: this.provider,
      id: normalized.id,
      stopReason: normalized.stop_reason,
      contentBlocks: normalized.content.length,
      elapsed: `${elapsed}ms`,
      elapsedMs: elapsed,
    }, 'Anthropic-compatible backend response:');
    if (elapsed > NON_STREAM_SLOW_MS) {
      logWarn('upstream_slow_response', {
        ...this.contextFields(logContext),
        provider: this.provider,
        upstreamModel: upstreamRequest.model,
        outwardModel,
        messages: upstreamRequest.messages.length,
        tools: upstreamRequest.tools?.length || 0,
        elapsedMs: elapsed,
        thresholdMs: NON_STREAM_SLOW_MS,
      });
    }

    return normalized;
  }

  private buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
      'anthropic-version': '2023-06-01',
      'User-Agent': 'Claude-Code/1.0.0',
      'X-Client-Name': 'claude-code',
      'X-Client-Version': '1.0.0',
    };
  }

  private buildUpstreamRequest(request: AnthropicRequest): AnthropicRequest {
    const messages = this.applyToolChoiceInstruction(
      this.applyToolProtocolInstruction(
        this.sanitizeMessagesForUpstream(request.messages),
        request.tools,
      ),
      request.tool_choice,
    );

    const upstreamRequest = {
      ...request,
      model: this.upstreamModel,
      stream: false,
      messages,
    } as AnthropicRequest & Record<string, unknown>;

    // DeepSeek 的 Anthropic 兼容端会强制要求完整回传 thinking 块。
    // Claude Code 工具循环里历史 thinking 可能被压缩或重建，历史工具交互因此转成文本转录。
    delete upstreamRequest.thinking;
    // DeepSeek 当前会拒绝 Anthropic 的强制 tool_choice；用提示保留意图，避免 400。
    delete upstreamRequest.tool_choice;

    return upstreamRequest as AnthropicRequest;
  }

  private applyToolChoiceInstruction(
    messages: AnthropicRequest['messages'],
    toolChoice: AnthropicRequest['tool_choice'],
  ): AnthropicRequest['messages'] {
    const instruction = this.toolChoiceToInstruction(toolChoice);
    if (!instruction) {
      return messages;
    }

    return this.appendInstructionToLastUser(messages, instruction);
  }

  private applyToolProtocolInstruction(
    messages: AnthropicRequest['messages'],
    tools: AnthropicRequest['tools'],
  ): AnthropicRequest['messages'] {
    if (!tools?.length) {
      return messages;
    }

    return this.appendInstructionToLastUser(
      messages,
      'Tool protocol: when you need a tool, emit a structured tool_use content block through the API. ' +
        'Lines like "[tool_use:Name] id=... input=..." and "[tool_result] tool_use_id=..." are a ' +
        'read-only transcript of what already happened. Never reproduce those lines to request a tool, ' +
        'and never write textual tool-call transcripts in normal text.',
    );
  }

  private appendInstructionToLastUser(
    messages: AnthropicRequest['messages'],
    instruction: string,
  ): AnthropicRequest['messages'] {
    const nextMessages = [...messages];
    let lastUserIndex = -1;
    for (let index = nextMessages.length - 1; index >= 0; index -= 1) {
      if (nextMessages[index]?.role === 'user') {
        lastUserIndex = index;
        break;
      }
    }

    if (lastUserIndex === -1) {
      return [...nextMessages, { role: 'user', content: instruction }];
    }

    const message = nextMessages[lastUserIndex]!;
    const instructionBlock: AnthropicContent = { type: 'text', text: instruction };
    const content = typeof message.content === 'string'
      ? `${message.content}\n\n${instruction}`
      : [...message.content, instructionBlock];
    nextMessages[lastUserIndex] = { role: message.role, content };
    return nextMessages;
  }

  private toolChoiceToInstruction(
    toolChoice: AnthropicRequest['tool_choice'],
  ): string | undefined {
    if (!toolChoice || toolChoice.type === 'auto') {
      return undefined;
    }

    if (toolChoice.type === 'any') {
      return 'Tool choice requirement: call one of the available tools for this turn.';
    }

    return `Tool choice requirement: call the tool named "${toolChoice.name}" for this turn.`;
  }

  private sanitizeMessagesForUpstream(
    messages: AnthropicRequest['messages'],
  ): AnthropicRequest['messages'] {
    return messages.flatMap((message) => {
      if (!Array.isArray(message.content)) {
        return [message];
      }

      const textParts = message.content.flatMap((block) => this.contentBlockToText(block));
      const text = textParts.join('\n').trim();

      if (!text) {
        return [];
      }

      return [
        {
          role: message.role,
          content: text,
        } satisfies AnthropicMessage,
      ];
    });
  }

  private contentBlockToText(block: AnthropicContent): string[] {
    if (block.type === 'text') {
      return block.text ? [block.text] : [];
    }

    if (block.type === 'image') {
      return ['[image content omitted]'];
    }

    if (block.type === 'tool_use') {
      return [
        `[tool_use:${block.name}] id=${block.id} input=${JSON.stringify(block.input ?? {})}`,
      ];
    }

    if (block.type === 'tool_result') {
      const content = this.toolResultContentToText(block.content);
      return [
        `[tool_result] tool_use_id=${block.tool_use_id}${block.is_error ? ' is_error=true' : ''}` +
        (content ? `\n${content}` : ''),
      ];
    }

    return [];
  }

  private toolResultContentToText(content: string | AnthropicContent[] | undefined): string {
    if (!content) {
      return '';
    }

    if (typeof content === 'string') {
      return content;
    }

    return content
      .flatMap((block) => this.contentBlockToText(block))
      .join('\n')
      .trim();
  }

  private normalizeResponse(
    data: unknown,
    outwardModel: string,
    logContext?: RequestLogContext,
    historyToolUseIds?: Set<string>,
    toolInputKeys?: ReadonlyMap<string, ReadonlySet<string>>,
  ): AnthropicResponse {
    if (!data || typeof data !== 'object') {
      throw new Error(`${this.provider} API returned invalid response format`);
    }

    const raw = data as Record<string, unknown>;
    if ('error' in raw || 'LocalError' in raw) {
      const error = raw.error as { message?: string } | string | undefined;
      const message = typeof error === 'string'
        ? error
        : error?.message || String(raw.LocalError || 'Unknown backend error');
      throw new Error(`${this.provider} API error: ${message}`);
    }

    const content = this.normalizeContent(
      raw.content,
      logContext,
      historyToolUseIds,
      toolInputKeys,
    );
    const stopReason = this.normalizeStopReason(raw.stop_reason);
    const hasToolUse = content.some((block) => block.type === 'tool_use');

    return {
      id: typeof raw.id === 'string' ? raw.id : `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      content,
      model: outwardModel,
      // 文本兜底还原出 tool_use 后，stop_reason 必须同步改成 tool_use，
      // 否则 Claude Code 会认为回合结束、停止 agent 循环。
      stop_reason: hasToolUse && (stopReason === 'end_turn' || stopReason === null)
        ? 'tool_use'
        : stopReason,
      ...(typeof raw.stop_sequence === 'string' ? { stop_sequence: raw.stop_sequence } : {}),
      usage: this.normalizeUsage(raw.usage),
    };
  }

  private normalizeContent(
    content: unknown,
    logContext?: RequestLogContext,
    historyToolUseIds?: Set<string>,
    toolInputKeys?: ReadonlyMap<string, ReadonlySet<string>>,
  ): AnthropicResponseContent[] {
    if (!Array.isArray(content) || content.length === 0) {
      throw new Error(`${this.provider} API response missing content array`);
    }

    const normalized = content.map((block): AnthropicResponseContent => {
      if (!block || typeof block !== 'object') {
        throw new Error(`${this.provider} API returned invalid content block`);
      }

      const item = block as Record<string, unknown>;
      if (item.type === 'text') {
        return {
          type: 'text',
          text: typeof item.text === 'string' ? item.text : '',
        };
      }

      if (item.type === 'thinking') {
        return {
          type: 'thinking',
          thinking: typeof item.thinking === 'string' ? item.thinking : '',
          ...(typeof item.signature === 'string' ? { signature: item.signature } : {}),
        };
      }

      if (item.type === 'redacted_thinking') {
        return {
          type: 'redacted_thinking',
          data: typeof item.data === 'string' ? item.data : '',
        };
      }

      if (item.type === 'tool_use') {
        return {
          type: 'tool_use',
          id: typeof item.id === 'string' ? item.id : `toolu_${crypto.randomUUID()}`,
          name: typeof item.name === 'string' ? item.name : '',
          input: this.asRecord(item.input),
        };
      }

      throw new Error(
        `${this.provider} API returned unsupported content block type: ${String(item.type)}`,
      );
    });

    const hasStructuredToolUse = normalized.some((block) => block.type === 'tool_use');
    if (hasStructuredToolUse) {
      return normalized;
    }

    const converted = this.normalizeTextualToolUseBlocks(
      normalized,
      historyToolUseIds,
      toolInputKeys,
    );
    if (converted.toolUseCount > 0) {
      logWarn('textual_tool_use_normalized', {
        ...this.contextFields(logContext),
        provider: this.provider,
        toolUseCount: converted.toolUseCount,
      });
    }
    if (converted.replayedCount > 0) {
      // 模型在复述历史工具轮而非发起新调用。还原它会重复执行一次工具
      // （含 Bash/Write 这类写操作），故保持文本。
      logWarn('textual_tool_use_replay_skipped', {
        ...this.contextFields(logContext),
        provider: this.provider,
        replayedCount: converted.replayedCount,
      });
    }

    if (converted.unparsedCount > 0) {
      // 这条日志就是"Claude Code 莫名停下、要人说'请继续'"的直接证据。
      // 没有它就只能靠翻聊天记录截图复原现场。
      logWarn('textual_tool_use_unparsed', {
        ...this.contextFields(logContext),
        provider: this.provider,
        unparsedCount: converted.unparsedCount,
      }, 'Textual tool call could not be restored; turn will end early');
    }

    return converted.content;
  }

  private normalizeTextualToolUseBlocks(
    blocks: AnthropicResponseContent[],
    historyToolUseIds?: Set<string>,
    toolInputKeys?: ReadonlyMap<string, ReadonlySet<string>>,
  ): {
    content: AnthropicResponseContent[];
    toolUseCount: number;
    replayedCount: number;
    unparsedCount: number;
  } {
    const next: AnthropicResponseContent[] = [];
    let toolUseCount = 0;
    let replayedCount = 0;
    let unparsedCount = 0;

    for (const block of blocks) {
      if (block.type !== 'text') {
        next.push(block);
        continue;
      }

      const convertedParts: AnthropicResponseContent[] = [];
      const pendingText: string[] = [];
      let converted = false;

      const flushText = () => {
        const text = pendingText.join('\n').trim();
        if (text) {
          convertedParts.push({ type: 'text', text });
        }
        pendingText.length = 0;
      };

      for (const line of block.text.split(/\r?\n/)) {
        const toolUse = this.parseTextualToolUseLine(line, toolInputKeys);
        if (!toolUse) {
          // 形状像调用却没解析出来 = 兜底网漏了一次，回合会退化成 end_turn。
          // 单独计数并告警，否则用户只会看到"助手莫名停下"，无从诊断。
          if (TEXTUAL_TOOL_LINE_SHAPE.test(line.trim())) {
            unparsedCount += 1;
          }
          pendingText.push(line);
          continue;
        }

        // id 已在本次请求历史里出现 = 模型在复述，不是新调用。
        if (toolUse.type === 'tool_use' && historyToolUseIds?.has(toolUse.id)) {
          replayedCount += 1;
          pendingText.push(line);
          continue;
        }

        flushText();
        convertedParts.push(toolUse);
        toolUseCount += 1;
        converted = true;
      }

      if (!converted) {
        next.push(block);
        continue;
      }

      flushText();
      next.push(...convertedParts);
    }

    return { content: next, toolUseCount, replayedCount, unparsedCount };
  }

  /**
   * 还原被模型当成调用协议模仿出来的文本工具调用。
   *
   * 两种转录格式都认，因为两个运行时的 sanitize 产出不同，
   * 且同一个上游会话可能跨运行时复用上下文：
   * - `[tool_use:X] id=Y input={...}`（Node 侧 sanitize 产出）
   * - `Previous assistant tool request: name=X id=Y input_json={...}`（Deno 侧产出）
   *
   * 不还原就会退化成纯文本 + stop_reason=end_turn，Claude Code 据此结束 agent 循环。
   */
  private parseTextualToolUseLine(
    line: string,
    toolInputKeys?: ReadonlyMap<string, ReadonlySet<string>>,
  ): AnthropicResponseContent | undefined {
    const trimmed = line.trim();
    const match =
      trimmed.match(/^\[tool_use:([^\]]+)\]\s+id=([^\s]+)\s+input=(.+)$/) ||
      trimmed.match(
        /^Previous assistant tool request:\s*name=(\S+)\s+id=(\S+)\s+input_json=(.+)$/,
      );
    if (!match) {
      return undefined;
    }

    const name = match[1]?.trim();
    const id = match[2]?.trim();
    const inputText = match[3]?.trim();
    if (!name || !id || !inputText?.startsWith('{')) {
      return undefined;
    }

    try {
      const input = parseLooseToolInputJson(inputText, toolInputKeys?.get(name));
      if (!input) {
        return undefined;
      }
      return {
        type: 'tool_use',
        id,
        name,
        input: this.asRecord(input),
      };
    } catch {
      return undefined;
    }
  }

  private normalizeUsage(usage: unknown): { input_tokens: number; output_tokens: number } {
    if (!usage || typeof usage !== 'object') {
      return { input_tokens: 0, output_tokens: 0 };
    }

    const raw = usage as Record<string, unknown>;
    return {
      input_tokens: typeof raw.input_tokens === 'number' ? raw.input_tokens : 0,
      output_tokens: typeof raw.output_tokens === 'number' ? raw.output_tokens : 0,
    };
  }

  private normalizeStopReason(value: unknown): AnthropicResponse['stop_reason'] {
    if (
      value === 'end_turn' ||
      value === 'max_tokens' ||
      value === 'stop_sequence' ||
      value === 'tool_use' ||
      value === null
    ) {
      return value;
    }

    return 'end_turn';
  }

  private asRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }

    return value as Record<string, unknown>;
  }

  async sendStreamRequest(
    request: AnthropicRequest,
    onChunk: (chunk: unknown) => void,
    onComplete: () => void,
    onError: (error: Error) => void,
    logContext?: RequestLogContext,
  ): Promise<void> {
    try {
      const response = await this.sendRequest({ ...request, stream: false }, logContext);
      onChunk({ type: 'message_start', message: response });
      onComplete();
    } catch (error) {
      onError(error instanceof Error ? error : new Error('Stream error'));
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/models`, {
        method: 'GET',
        headers: this.buildHeaders(),
      });
      return response.ok;
    } catch (error) {
      consola.error('Anthropic-compatible backend health check failed:', error);
      return false;
    }
  }

  private contextFields(logContext?: RequestLogContext): Record<string, unknown> {
    if (!logContext) {
      return {};
    }

    return {
      requestId: logContext.requestId,
      requestHash: logContext.requestHash,
    };
  }
}

/**
 * 解析模型模仿产出的 input_json。
 *
 * 三级递进，每级都比上一级更宽容，但都必须以「能解析成合法对象」收尾；
 * 全部失败就返回 undefined，老实退回文本 —— 宁可少还原一次，也不能伪造
 * 出参数错误的工具调用（对 Bash/Write 这类写操作尤其重要）。
 *
 * 1. 严格 JSON。
 * 2. 补未转义的反斜杠。转录由 `JSON.stringify` 生成，Windows 路径在里面是
 *    `C:\\Users`；模型模仿时几乎必然按人类写法还原成 `C:\Users`，
 *    `JSON.parse` 抛 "Bad escaped character"。
 * 3. 补未转义的内层双引号。命令里带引号是常态（`echo "x"`、`python -c "…"`、
 *    `curl -H "…"`），模型模仿时同样不会转义，字面量边界因此错位。
 *
 * 三级失败会让响应退化成 end_turn，Claude Code 判定回合结束、agent 循环停止。
 */
function parseLooseToolInputJson(
  inputText: string,
  allowedKeys?: ReadonlySet<string>,
): unknown {
  try {
    return JSON.parse(inputText);
  } catch {
    // 继续尝试修补
  }

  try {
    return JSON.parse(repairJsonBackslashes(inputText));
  } catch {
    // 继续尝试修补
  }

  const quoted = escapeInnerQuotes(inputText, allowedKeys);
  if (!quoted) {
    return undefined;
  }

  try {
    return JSON.parse(repairJsonBackslashes(quoted));
  } catch {
    return undefined;
  }
}

/**
 * 把字符串值内部未转义的双引号补成 `\"`，据此还原正确的字面量边界。
 *
 * 难点是判断一个 `"` 到底是「值结束」还是「值内容」。通用 JSON 修复器只能
 * 看字符串猜，于是在 `{"command":"echo "a", b"}` 这类输入上必须在「截断」和
 * 「合并」之间赌一把——赌错方向会把 `rm -rf /tmp/x` 截成 `rm -rf /`。
 *
 * 但我们是协议代理，手里有这个工具的 `input_schema`，于是可以把猜测换成
 * **有判据的假设检验**：一个 `"` 只有在其后紧跟 `,"<本工具声明过的键>":`
 * 时才算值结束。`echo "a", b` 里的逗号后面是 ` b`，不是合法键，因此不构成
 * 终止符，命令不会被截断。
 *
 * 候选取**最早**的合法键终止符（而不是最晚）：取最晚会把后续字段一并吞进
 * 前一个值。若一个合法键终止符都没有，才退化为「值一直延伸到对象结束」——
 * 这个方向只会让内容偏多，不会截断，对 shell 命令是更安全的失败方向。
 *
 * 拿不到 schema（请求未带 tools，或工具名对不上）时退回「键形」正则判据，
 * 弱一些，但仍远强于裸逗号。
 *
 * 已知局限：命令内容里若真的出现 `","<本工具的合法键>":` 会被误判为字段
 * 分隔。构造出这种命令需要刻意为之，实践中不出现。
 */
function escapeInnerQuotes(
  text: string,
  allowedKeys?: ReadonlySet<string>,
): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return undefined;
  }

  let out = '{';
  let index = 1;

  const skipWhitespace = () => {
    while (index < trimmed.length && /\s/.test(trimmed[index] ?? '')) {
      out += trimmed[index];
      index += 1;
    }
  };

  while (true) {
    skipWhitespace();
    if (trimmed[index] === '}') {
      return out + trimmed.slice(index);
    }
    // 键本身被模型写坏的情况实践中不出现，按严格规则读；读不出就整体放弃。
    if (trimmed[index] !== '"') {
      return undefined;
    }

    const key = readStringLiteral(trimmed, index);
    if (!key) {
      return undefined;
    }
    out += `"${key.body}"`;
    index = key.end;

    skipWhitespace();
    if (trimmed[index] !== ':') {
      return undefined;
    }
    out += ':';
    index += 1;
    skipWhitespace();

    if (trimmed[index] === '"') {
      const end = findStringValueEnd(trimmed, index, allowedKeys);
      if (end === undefined) {
        return undefined;
      }
      out += `"${escapeRawQuotes(trimmed.slice(index + 1, end))}"`;
      index = end + 1;
    } else {
      const end = findNonStringValueEnd(trimmed, index);
      if (end === undefined) {
        return undefined;
      }
      out += trimmed.slice(index, end);
      index = end;
    }

    skipWhitespace();
    if (trimmed[index] === ',') {
      out += ',';
      index += 1;
      continue;
    }
    if (trimmed[index] === '}') {
      return out + trimmed.slice(index);
    }
    return undefined;
  }
}

/** 值内容里一个 `"` 是否构成字面量结束：后面必须是合法键，或对象结束。 */
function isValueTerminator(
  text: string,
  after: number,
  allowedKeys?: ReadonlySet<string>,
): 'key' | 'end' | undefined {
  const rest = text.slice(after);
  if (/^\s*\}\s*$/.test(rest)) {
    return 'end';
  }
  const nextKey = rest.match(/^\s*,\s*"([^"\\]*)"\s*:/);
  if (!nextKey) {
    return undefined;
  }
  const name = nextKey[1] ?? '';
  const looksLikeKey = allowedKeys
    ? allowedKeys.has(name)
    : /^[A-Za-z_-][\w-]*$/.test(name);
  return looksLikeKey ? 'key' : undefined;
}

/** 定位字符串值的结束引号；start 指向起始引号。 */
function findStringValueEnd(
  text: string,
  start: number,
  allowedKeys?: ReadonlySet<string>,
): number | undefined {
  let objectEnd: number | undefined;

  for (let i = start + 1; i < text.length; i += 1) {
    if (text[i] === '\\') {
      i += 1; // 连同被转义的字符整体跳过
      continue;
    }
    if (text[i] !== '"') {
      continue;
    }

    const kind = isValueTerminator(text, i + 1, allowedKeys);
    if (kind === 'key') {
      return i; // 最早的合法键终止符即为答案
    }
    if (kind === 'end' && objectEnd === undefined) {
      objectEnd = i;
    }
  }

  return objectEnd;
}

/** 定位非字符串值（数字/布尔/null/数组/对象）的结束位置。 */
function findNonStringValueEnd(text: string, start: number): number | undefined {
  let depth = 0;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      const literal = readStringLiteral(text, i);
      if (!literal) return undefined;
      i = literal.end - 1;
      continue;
    }
    if (char === '[' || char === '{') {
      depth += 1;
      continue;
    }
    if (char === ']' || char === '}') {
      if (depth === 0) return i;
      depth -= 1;
      continue;
    }
    if (char === ',' && depth === 0) {
      return i;
    }
  }

  return undefined;
}

/** 保留已转义的 `\"`，把裸引号补成 `\"`。反斜杠的修补交给后一级。 */
function escapeRawQuotes(body: string): string {
  let out = '';
  let index = 0;

  while (index < body.length) {
    const char = body[index];
    if (char === '\\') {
      out += char + (body[index + 1] ?? '');
      index += 2;
      continue;
    }
    out += char === '"' ? '\\"' : char;
    index += 1;
  }

  return out;
}

/** JSON 规范允许的转义字符。其余跟在反斜杠后的字符都属于非法转义。 */
const LEGAL_JSON_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't']);

/**
 * 把 JSON 文本里未转义的反斜杠补成 `\\`，逐个字符串字面量处理。
 *
 * 难点是 `\b` `\f` `\n` `\r` `\t` 既是合法转义，也是 Windows 路径的常见开头
 * （`\bin`、`\node_modules`、`\report`、`\temp`）。单看转义序列无法消歧，
 * 因此先取出整个字面量判断它像不像路径（盘符前缀）：
 * - 像路径 → 按反斜杠连续段的奇偶判断：奇数段是模型漏转义的分隔符，补成双份；
 *   偶数段说明这一段本来就转义正确，原样保留。
 * - 不像路径 → 合法转义照常生效，只补救非法转义。
 *
 * 已知局限见 deno/src/adapters/anthropic-adapter.ts 与对应测试用例：
 * UNC 路径无盘符前缀识别不出；整串本身合法时（如 `"d:\tmp"`）修补不会触发。
 */
function repairJsonBackslashes(text: string): string {
  let out = '';
  let index = 0;

  while (index < text.length) {
    const char = text[index];
    if (char !== '"') {
      out += char;
      index += 1;
      continue;
    }

    const literal = readStringLiteral(text, index);
    if (!literal) {
      // 引号未闭合，交给 JSON.parse 去报错。
      out += text.slice(index);
      break;
    }

    out += `"${rewriteLiteralBody(literal.body)}"`;
    index = literal.end;
  }

  return out;
}

/** 从 start 处的引号开始读一个字符串字面量，返回原始内容与结束位置（引号后一位）。 */
function readStringLiteral(
  text: string,
  start: number,
): { body: string; end: number } | undefined {
  let index = start + 1;
  let body = '';

  while (index < text.length) {
    const char = text[index];
    if (char === '\\') {
      // 无论转义是否合法，都连同下一个字符整体带走，避免把 \" 误判成结束引号。
      body += char + (text[index + 1] ?? '');
      index += 2;
      continue;
    }
    if (char === '"') {
      return { body, end: index + 1 };
    }
    body += char;
    index += 1;
  }

  return undefined;
}

function rewriteLiteralBody(body: string): string {
  return looksLikeWindowsPath(body) ? rewritePathLiteral(body) : rewritePlainLiteral(body);
}

/** 路径字面量：反斜杠一律是分隔符，按连续段奇偶决定是否补转义。 */
function rewritePathLiteral(body: string): string {
  let out = '';
  let index = 0;

  while (index < body.length) {
    if (body[index] !== '\\') {
      out += body[index];
      index += 1;
      continue;
    }

    let run = 0;
    while (body[index + run] === '\\') {
      run += 1;
    }

    // 段尾紧跟引号时，最后一个反斜杠属于 \" 转义，不算分隔符。
    const followedByQuote = body[index + run] === '"';
    const separators = followedByQuote ? run - 1 : run;

    // 偶数段 = 已经转义正确，原样保留；奇数段 = 漏转义，补成双份。
    out += separators % 2 === 0 ? '\\'.repeat(separators) : '\\'.repeat(separators * 2);

    if (followedByQuote) {
      out += '\\"';
      index += run + 1;
    } else {
      index += run;
    }
  }

  return out;
}

/** 非路径字面量：合法转义原样生效，只补救非法转义。 */
function rewritePlainLiteral(body: string): string {
  let out = '';
  let index = 0;

  while (index < body.length) {
    if (body[index] !== '\\') {
      out += body[index];
      index += 1;
      continue;
    }

    const next = body[index + 1];
    if (next === undefined) {
      out += '\\\\';
      index += 1;
      continue;
    }

    if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(body.slice(index + 2, index + 6))) {
      out += body.slice(index, index + 6);
      index += 6;
      continue;
    }

    out += LEGAL_JSON_ESCAPES.has(next) ? `\\${next}` : `\\\\${next}`;
    index += 2;
  }

  return out;
}

/** 盘符前缀 —— 判定该字面量整体是 Windows 路径。 */
function looksLikeWindowsPath(body: string): boolean {
  return /^[A-Za-z]:\\/.test(body);
}

/**
 * 「这一行形状像文本工具调用」的判据，只看结构不看 JSON 是否合法。
 * 用于统计兜底漏掉的次数——解析失败与「本来就不是调用」必须分开计数，
 * 否则前者会静默混进普通文本里，只表现为"助手莫名停下"。
 */
const TEXTUAL_TOOL_LINE_SHAPE =
  /^(Previous assistant tool request:\s*name=\S+\s+id=\S+\s+input_json=\{|\[tool_use:[^\]]+\]\s+id=\S+\s+input=\{)/;

/**
 * 采集各工具 `input_schema` 声明的合法键。
 *
 * 这是 schema 制导修复的判据来源：修复未转义的内层双引号时，靠它判断
 * 一个 `"` 后面跟的到底是真字段分隔，还是命令内容里恰好出现的逗号加引号。
 * 通用 JSON 修复器没有这个信息，只能猜。
 */
function collectToolInputKeys(
  tools: AnthropicRequest['tools'],
): Map<string, ReadonlySet<string>> {
  const map = new Map<string, ReadonlySet<string>>();

  for (const tool of tools ?? []) {
    const name = (tool as { name?: unknown }).name;
    const properties = (tool as { input_schema?: { properties?: unknown } })
      .input_schema?.properties;
    if (typeof name !== 'string' || !properties || typeof properties !== 'object') {
      continue;
    }
    map.set(name, new Set(Object.keys(properties as Record<string, unknown>)));
  }

  return map;
}

/**
 * 采集本次请求历史里已出现的 tool_use id。
 * 用于识别「模型复述历史」而非发起新调用，避免还原后重复执行工具。
 */
function collectHistoryToolUseIds(messages: AnthropicRequest['messages']): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      continue;
    }
    for (const block of message.content) {
      if (block.type === 'tool_use' && block.id) {
        ids.add(block.id);
      } else if (block.type === 'tool_result' && block.tool_use_id) {
        ids.add(block.tool_use_id);
      }
    }
  }
  return ids;
}
