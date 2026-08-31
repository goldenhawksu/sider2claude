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
import {
  collectHistoryToolUseIds,
  collectToolInputKeys,
  normalizeTextualToolUseBlocks,
} from '../utils/textual-tool-use';
import { applyStopSequences } from '../utils/stop-sequences';

/**
 * 低于这个 `max_tokens` 就主动关掉上游 thinking。
 *
 * 取 1024 来自 probe 实测（deno/tools/probe-upstream-max-tokens.ts）：256 时预算全被
 * 推理吃光、正文 0 字；1024 时才开始有正文（thinking 用掉约 600 tokens）。
 * 阈值取在「刚好够 thinking + 一点正文」的位置，再低就必然拿到空响应。
 */
const THINKING_MIN_BUDGET_TOKENS = 1024;

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
      // `tool_choice: none` 下不做文本工具调用还原：调用方已明确禁止工具，
      // 上游若仍吐出转录格式的一行，那是它没听指令，还原它等于替上游把禁令推翻。
      request.tool_choice?.type !== 'none',
      request.stop_sequences,
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
      this.sanitizeMessagesForUpstream(request.messages),
      request.tool_choice,
    );

    // `tool_choice: none` 只能靠隐藏工具兑现：probe 实测上游完全忽略 tool_choice
    // （no/auto/any/tool/none 五种形态返回一模一样的 tool_use，见
    // deno/tools/probe-deepseek-tool-choice.ts），透传和注入文本指令都拦不住它。
    // 代价是这一轮的缓存前缀会变——调用方既然明确说了「这轮别用工具」，
    // 正确性优先于命中率。
    const suppressTools = request.tool_choice?.type === 'none';
    const upstreamTools = suppressTools ? undefined : request.tools;

    const upstreamRequest = {
      ...request,
      model: this.upstreamModel,
      stream: false,
      messages,
      // 防模仿提示词挂在 system 上，不挂在最后一条 user 消息上。
      // 挂在消息尾部时，同一条消息在下一轮就不再是"最后一条"、也就不再带这段
      // 后缀——同一个逻辑位置在两轮之间字节不同，上游 prefix 缓存必然在那里断掉。
      // system 逐轮不变，因此这段文字随稳定前缀一起被缓存。
      system: this.applyToolProtocolInstruction(request.system, upstreamTools),
    } as AnthropicRequest & Record<string, unknown>;

    if (upstreamRequest.system === undefined) {
      delete upstreamRequest.system;
    }

    // DeepSeek 的 Anthropic 兼容端会强制要求完整回传 thinking 块。
    // Claude Code 工具循环里历史 thinking 可能被压缩或重建，历史工具交互因此转成文本转录。
    delete upstreamRequest.thinking;

    // 小预算下主动关掉 thinking。
    //
    // 上游默认开着 thinking，而 thinking 与正文共享 max_tokens。probe 实测
    // （deno/tools/probe-upstream-max-tokens.ts）max_tokens=16/64/256 时预算全被推理
    // 吃光，返回 `content=[thinking]`、正文 0 字、`stop_reason=max_tokens`——
    // 调用方拿到一个「成功但没有内容」的响应。`thinking:{type:'disabled'}` 是
    // 唯一实测有效的开关（budget_tokens、reasoning.enabled 都被忽略）。
    //
    // 只在装不下时才关，不一律关：thinking 是 glm 推理质量的一部分，无差别关掉
    // 会波及工具调用准确率。调用方显式要了 extended thinking 的更要尊重——
    // 那时预算怎么分是它自己的选择。
    if (
      request.thinking?.type !== 'enabled' &&
      typeof request.max_tokens === 'number' &&
      request.max_tokens > 0 &&
      request.max_tokens < THINKING_MIN_BUDGET_TOKENS
    ) {
      upstreamRequest.thinking = { type: 'disabled' };
    }
    // 只有 `{type:'tool'}` 会被上游拒绝（"Thinking mode does not support this
    // tool_choice"，实测见 deno/tools/probe-deepseek-tool-choice.ts）；auto / any / none
    // 原生透传。原先一律删掉再注入文本，等于给每个带 tool_choice 的请求都在消息
    // 尾部加一段逐轮变化的文字，白白打断上游缓存前缀。
    if (request.tool_choice?.type === 'tool') {
      delete upstreamRequest.tool_choice;
    }

    if (suppressTools) {
      delete upstreamRequest.tools;
      // 没有 tools 时 tool_choice 无从谈起，一并摘掉免得上游报参数错。
      delete upstreamRequest.tool_choice;
    }

    // stop_sequences 不发给上游：实测它会把截断作用在 thinking 上，推理里撞到序列
    // 就整个停下，返回 content=[thinking]、正文一个字都没有（常见字符几乎必然出现
    // 在推理里，等于用了就大概率拿到空响应）。改由 normalizeResponse 在正文上截断。
    delete upstreamRequest.stop_sequences;

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
      'Lines like "[tool_use:Name] id=... input=..." and "[tool_result] tool_use_id=..." are a ' +
      'read-only transcript of what already happened. Never reproduce those lines to request a tool, ' +
      'and never write textual tool-call transcripts in normal text.';

    return system ? `${system}

${instruction}` : instruction;
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

  /**
   * 把历史消息整理成上游能接受的形态。
   *
   * 默认策略是**整条压平成纯文本**：上游在 thinking 模式下会校验
   * `content[].thinking` 的完整 passback，把 Claude Code 压缩过的历史结构原样
   * 转发会直接 400（见 deepseek-adapter.test.ts 的转录用例）。
   *
   * 唯一的例外是图片。上游是 VLM，原生支持图文混排，压平会让视觉能力静默消失
   * ——API 收下 200，模型却答「我没有收到图片」。因此含图片的消息改走数组形态：
   * 图片原样保留，其余块仍按老规矩转成文本块。
   *
   * 例外**只对含图片的消息生效**：不含图片的消息必须维持纯字符串，否则发往上游
   * 的请求前缀会逐轮变形，打断 prompt 缓存（命中与未命中有 31 倍价差，
   * 见 prompt-cache.test.ts）。
   */
  private sanitizeMessagesForUpstream(
    messages: AnthropicRequest['messages'],
  ): AnthropicRequest['messages'] {
    return messages.flatMap((message) => {
      if (!Array.isArray(message.content)) {
        return [message];
      }

      if (message.content.some((block) => block.type === 'image')) {
        return this.sanitizeMessageWithImages(message);
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

  /**
   * 含图片的消息：图片原样透传，相邻的非图片块合并成文本块。
   *
   * 合并而不是逐块转换，是为了让文本部分的形态与纯文本路径保持一致——
   * 同一段历史不该因为旁边多了张图就换一种拼法。
   */
  private sanitizeMessageWithImages(
    message: AnthropicMessage,
  ): AnthropicRequest['messages'] {
    const blocks: AnthropicContent[] = [];
    let pendingText: string[] = [];

    const flushText = () => {
      const text = pendingText.join('\n').trim();
      if (text) {
        blocks.push({ type: 'text', text });
      }
      pendingText = [];
    };

    for (const block of message.content as AnthropicContent[]) {
      if (block.type === 'image') {
        flushText();
        blocks.push(block);
        continue;
      }
      pendingText.push(...this.contentBlockToText(block));
    }
    flushText();

    if (!blocks.length) {
      return [];
    }

    return [{ role: message.role, content: blocks } satisfies AnthropicMessage];
  }

  private contentBlockToText(block: AnthropicContent): string[] {
    if (block.type === 'text') {
      return block.text ? [block.text] : [];
    }

    if (block.type === 'image') {
      // 顶层消息里的图片不会走到这里（由 sanitizeMessageWithImages 原样透传）。
      // 只有嵌在 tool_result 里的图片会命中——那种位置整体要转文本，留不住结构。
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
    allowTextualToolUse = true,
    stopSequences?: string[],
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
      allowTextualToolUse,
    );
    const stopReason = this.normalizeStopReason(raw.stop_reason);

    // stop_sequences 在本层兑现：上游要么不支持（Sider），要么把截断作用在
    // thinking 上并把命中报成 end_turn（glm-5.3-flash，见
    // deno/tools/probe-upstream-stop-sequences.ts）。两种都不能直接透传给调用方。
    const stopped = applyStopSequences(content, stopSequences);
    const hasToolUse = stopped.content.some((block) => block.type === 'tool_use');

    return {
      id: typeof raw.id === 'string' ? raw.id : `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      content: stopped.content,
      model: outwardModel,
      // 文本兜底还原出 tool_use 后，stop_reason 必须同步改成 tool_use，
      // 否则 Claude Code 会认为回合结束、停止 agent 循环。
      stop_reason: stopped.matched
        ? 'stop_sequence'
        : hasToolUse && (stopReason === 'end_turn' || stopReason === null)
        ? 'tool_use'
        : stopReason,
      ...(stopped.matched
        ? { stop_sequence: stopped.matched }
        : typeof raw.stop_sequence === 'string'
        ? { stop_sequence: raw.stop_sequence }
        : {}),
      usage: this.normalizeUsage(raw.usage),
    };
  }

  private normalizeContent(
    content: unknown,
    logContext?: RequestLogContext,
    historyToolUseIds?: Set<string>,
    toolInputKeys?: ReadonlyMap<string, ReadonlySet<string>>,
    allowTextualToolUse = true,
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

    // `tool_choice: none`：调用方明确禁止工具，转录格式的一行文本就让它保持文本。
    if (!allowTextualToolUse) {
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

