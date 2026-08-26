/**
 * Anthropic Messages 兼容后端适配器。
 *
 * 当前用于 DeepSeek 的 /anthropic 兼容入口。它对上游使用 DeepSeek 模型，
 * 对下游仍保持 Claude Code 请求里的 Claude 模型名，让本服务对外表现为
 * 完整 Anthropic 能力代理。
 */

import type {
  AnthropicContent,
  AnthropicMessage,
  AnthropicRequest,
  AnthropicResponse,
  AnthropicResponseContent,
} from '../types/anthropic.ts';
import type { AnthropicBackendConfig } from '../config/backends.ts';
import {
  logError,
  logInfo,
  logWarn,
  NON_STREAM_SLOW_MS,
  type RequestLogContext,
} from '../utils/request-observability.ts';
import { getEnv } from '../utils/env.ts';
import {
  collectHistoryToolUseIds,
  collectToolInputKeys,
  normalizeTextualToolUseBlocks,
} from '../utils/textual-tool-use.ts';

const DEFAULT_UPSTREAM_TIMEOUT_MS = 90_000;

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
  private requestTimeoutMs: number;

  constructor(config: AnthropicBackendConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.upstreamModel = config.model;
    this.provider = config.provider;
    this.requestTimeoutMs = parseTimeoutMs();
  }

  async sendRequest(
    request: AnthropicRequest,
    logContext?: RequestLogContext,
  ): Promise<AnthropicResponse> {
    const startTime = Date.now();
    const outwardModel = request.model;
    const upstreamRequest = this.buildUpstreamRequest(request, false);

    logInfo('upstream_request', {
      ...this.contextFields(logContext),
      provider: this.provider,
      upstreamModel: upstreamRequest.model,
      outwardModel,
      messages: upstreamRequest.messages.length,
      tools: upstreamRequest.tools?.length || 0,
      requestedStream: !!request.stream,
    }, 'Forwarding Anthropic-compatible request:');

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(upstreamRequest),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (error) {
      this.handleFetchError(error, logContext, startTime);
    }

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

  private buildUpstreamRequest(request: AnthropicRequest, stream: boolean): AnthropicRequest {
    const messages = this.applyToolChoiceInstruction(
      this.sanitizeMessagesForUpstream(request.messages),
      request.tool_choice,
    );

    const upstreamRequest = {
      ...request,
      model: this.upstreamModel,
      stream,
      messages,
      // 防模仿提示词挂在 system 上，不挂在最后一条 user 消息上。
      // 挂在消息尾部时，同一条消息在下一轮就不再是"最后一条"、也就不再带这段
      // 后缀——同一个逻辑位置在两轮之间字节不同，上游 prefix 缓存必然在那里断掉。
      // system 逐轮不变，因此这段文字随稳定前缀一起被缓存。
      system: this.applyToolProtocolInstruction(request.system, request.tools),
    } as AnthropicRequest & Record<string, unknown>;

    if (upstreamRequest.system === undefined) {
      delete upstreamRequest.system;
    }

    // DeepSeek 的 Anthropic 兼容端会强制要求完整回传 thinking 块。
    // Claude Code 工具循环里历史 thinking 可能被压缩或重建，历史工具交互因此转成文本转录。
    delete upstreamRequest.thinking;
    // 只有 `{type:'tool'}` 会被上游拒绝（"Thinking mode does not support this
    // tool_choice"，实测见 tools/probe-deepseek-tool-choice.ts）；auto / any / none
    // 原生透传。原先一律删掉再注入文本，等于给每个带 tool_choice 的请求都在消息
    // 尾部加一段逐轮变化的文字，白白打断上游缓存前缀。
    if (request.tool_choice?.type === 'tool') {
      delete upstreamRequest.tool_choice;
    }

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
    system: AnthropicRequest['system'],
    tools: AnthropicRequest['tools'],
  ): AnthropicRequest['system'] {
    if (!tools?.length) {
      return system;
    }

    const instruction =
      'Tool protocol: when you need a tool, emit a structured tool_use content block through the API. ' +
      'Lines like "Previous assistant tool request: name=... id=... input_json=..." and ' +
      '"Previous tool result: ..." are a read-only transcript of what already happened. ' +
      'Never reproduce those lines to request a tool, and never write textual tool-call ' +
      'transcripts such as [tool_use:Name] in normal text.';

    return system ? `${system}\n\n${instruction}` : instruction;
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
    // 只有强制指定某个工具这一种需要文本兜底；其余形态原生透传给上游。
    if (toolChoice?.type !== 'tool') {
      return undefined;
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
        `Previous assistant tool request: name=${block.name} id=${block.id} input_json=${
          JSON.stringify(block.input ?? {})
        }`,
      ];
    }

    if (block.type === 'tool_result') {
      const content = this.toolResultContentToText(block.content);
      return [
        `Previous tool result: tool_use_id=${block.tool_use_id}${
          block.is_error ? ' is_error=true' : ''
        }` +
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
    const usage = this.normalizeUsage(raw.usage);
    const stopReason = this.normalizeStopReason(raw.stop_reason);
    const hasToolUse = content.some((block) => block.type === 'tool_use');

    return {
      id: typeof raw.id === 'string' ? raw.id : `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      content,
      model: outwardModel,
      stop_reason: hasToolUse && (stopReason === 'end_turn' || stopReason === null)
        ? 'tool_use'
        : stopReason,
      ...(typeof raw.stop_sequence === 'string' ? { stop_sequence: raw.stop_sequence } : {}),
      usage,
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

    const converted = normalizeTextualToolUseBlocks(
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

  private normalizeUsage(usage: unknown): AnthropicResponse['usage'] {
    if (!usage || typeof usage !== 'object') {
      return { input_tokens: 0, output_tokens: 0 };
    }

    const raw = usage as Record<string, unknown>;
    const optionalCount = (key: string): number | undefined =>
      typeof raw[key] === 'number' ? raw[key] as number : undefined;

    const cacheCreation = optionalCount('cache_creation_input_tokens');
    const cacheRead = optionalCount('cache_read_input_tokens');

    return {
      input_tokens: typeof raw.input_tokens === 'number' ? raw.input_tokens : 0,
      output_tokens: typeof raw.output_tokens === 'number' ? raw.output_tokens : 0,
      ...(cacheCreation === undefined ? {} : { cache_creation_input_tokens: cacheCreation }),
      ...(cacheRead === undefined ? {} : { cache_read_input_tokens: cacheRead }),
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
    const outwardModel = request.model;
    const upstreamRequest = this.buildUpstreamRequest(request, true);

    try {
      const response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(upstreamRequest),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logError('upstream_stream_error', {
          ...this.contextFields(logContext),
          provider: this.provider,
          status: response.status,
          statusText: response.statusText,
          preview: errorText.substring(0, 300),
        }, 'Anthropic-compatible backend stream error:');
        throw new Error(`${this.provider} API error: ${response.status} ${response.statusText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error(`${this.provider} API returned no response body`);
      }

      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            this.forwardSSELine(line.trim(), outwardModel, onChunk);
          }
        }

        if (buffer.trim()) {
          this.forwardSSELine(buffer.trim(), outwardModel, onChunk);
        }
      } finally {
        reader.releaseLock();
      }

      onComplete();
    } catch (error) {
      onError(error instanceof Error ? error : new Error('Stream error'));
    }
  }

  /**
   * 透传一行上游 SSE 事件。DeepSeek 输出已是 Anthropic SSE 格式，仅在 message_start
   * 把上游模型名改回对外 Claude 模型名，其余（thinking_delta / input_json_delta 等）原样透传。
   */
  private forwardSSELine(
    line: string,
    outwardModel: string,
    onChunk: (chunk: unknown) => void,
  ): void {
    if (!line.startsWith('data:')) {
      return;
    }
    const dataStr = line.substring(5).trim();
    if (!dataStr || dataStr === '[DONE]') {
      return;
    }

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(dataStr) as Record<string, unknown>;
    } catch {
      return;
    }

    if (event.type === 'message_start' && event.message && typeof event.message === 'object') {
      (event.message as Record<string, unknown>).model = outwardModel;
    }

    onChunk(event);
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/models`, {
        method: 'GET',
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(Math.min(this.requestTimeoutMs, 10_000)),
      });
      return response.ok;
    } catch (error) {
      console.error('Anthropic-compatible backend health check failed:', error);
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

  private handleFetchError(
    error: unknown,
    logContext: RequestLogContext | undefined,
    startTime: number,
  ): never {
    const elapsed = Date.now() - startTime;
    if (isAbortError(error)) {
      logError('upstream_timeout', {
        ...this.contextFields(logContext),
        provider: this.provider,
        timeoutMs: this.requestTimeoutMs,
        elapsedMs: elapsed,
      });
      throw new AnthropicBackendError(
        `${this.provider} API timeout after ${this.requestTimeoutMs}ms`,
        503,
        this.provider,
      );
    }

    throw error;
  }
}

function parseTimeoutMs(): number {
  const raw = getEnv('DEEPSEEK_REQUEST_TIMEOUT_MS', String(DEFAULT_UPSTREAM_TIMEOUT_MS));
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_UPSTREAM_TIMEOUT_MS;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'TimeoutError' ||
    error instanceof DOMException && error.name === 'AbortError' ||
    error instanceof Error && error.name === 'AbortError' ||
    error instanceof Error && error.name === 'TimeoutError';
}
