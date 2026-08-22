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

    const content = this.normalizeContent(raw.content, logContext, historyToolUseIds);
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

    const converted = this.normalizeTextualToolUseBlocks(normalized, historyToolUseIds);
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

    return converted.content;
  }

  private normalizeTextualToolUseBlocks(
    blocks: AnthropicResponseContent[],
    historyToolUseIds?: Set<string>,
  ): { content: AnthropicResponseContent[]; toolUseCount: number; replayedCount: number } {
    const next: AnthropicResponseContent[] = [];
    let toolUseCount = 0;
    let replayedCount = 0;

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
        const toolUse = this.parseTextualToolUseLine(line);
        if (!toolUse) {
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

    return { content: next, toolUseCount, replayedCount };
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
  private parseTextualToolUseLine(line: string): AnthropicResponseContent | undefined {
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
      const input = JSON.parse(inputText) as unknown;
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
