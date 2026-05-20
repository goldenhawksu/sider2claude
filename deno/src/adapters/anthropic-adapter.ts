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

  async sendRequest(request: AnthropicRequest): Promise<AnthropicResponse> {
    const startTime = Date.now();
    const outwardModel = request.model;
    const upstreamRequest = this.buildUpstreamRequest(request);

    console.info('Forwarding Anthropic-compatible request:', {
      provider: this.provider,
      upstreamModel: upstreamRequest.model,
      outwardModel,
      messages: upstreamRequest.messages.length,
      tools: upstreamRequest.tools?.length || 0,
      requestedStream: !!request.stream,
    });

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(upstreamRequest),
    });

    const elapsed = Date.now() - startTime;
    if (!response.ok) {
      const errorText = await response.text();
      console.error('Anthropic-compatible backend error:', {
        provider: this.provider,
        status: response.status,
        statusText: response.statusText,
        preview: errorText.substring(0, 300),
        elapsed: `${elapsed}ms`,
      });
      throw new Error(`${this.provider} API error: ${response.status} ${response.statusText}`);
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
    const normalized = this.normalizeResponse(data, outwardModel);

    console.info('Anthropic-compatible backend response:', {
      provider: this.provider,
      id: normalized.id,
      stopReason: normalized.stop_reason,
      contentBlocks: normalized.content.length,
      elapsed: `${elapsed}ms`,
    });

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
    const upstreamRequest = {
      ...request,
      model: this.upstreamModel,
      stream: false,
      messages: this.sanitizeMessagesForUpstream(request.messages),
    } as AnthropicRequest & Record<string, unknown>;

    // DeepSeek 的 Anthropic 兼容端会强制要求完整回传 thinking 块。
    // Claude Code 工具循环里历史 thinking 可能被压缩或重建，历史工具交互因此转成文本转录。
    delete upstreamRequest.thinking;

    return upstreamRequest as AnthropicRequest;
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

  private normalizeResponse(data: unknown, outwardModel: string): AnthropicResponse {
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

    const content = this.normalizeContent(raw.content);
    const usage = this.normalizeUsage(raw.usage);
    const stopReason = this.normalizeStopReason(raw.stop_reason);

    return {
      id: typeof raw.id === 'string' ? raw.id : `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      content,
      model: outwardModel,
      stop_reason: stopReason,
      ...(typeof raw.stop_sequence === 'string' ? { stop_sequence: raw.stop_sequence } : {}),
      usage,
    };
  }

  private normalizeContent(content: unknown): AnthropicResponseContent[] {
    if (!Array.isArray(content) || content.length === 0) {
      throw new Error(`${this.provider} API response missing content array`);
    }

    return content.map((block): AnthropicResponseContent => {
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
  ): Promise<void> {
    try {
      const response = await this.sendRequest({ ...request, stream: false });
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
      console.error('Anthropic-compatible backend health check failed:', error);
      return false;
    }
  }
}
