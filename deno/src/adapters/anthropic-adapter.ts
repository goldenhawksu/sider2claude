/**
 * Anthropic API 适配器
 * 透传请求到官方 Anthropic API
 */

import type { AnthropicRequest, AnthropicResponse } from '../types/anthropic.ts';
import type { AnthropicBackendConfig } from '../config/backends.ts';


// 模型名称映射 - 将 Claude Code 标准名称映射到第三方 API 支持的名称
const MODEL_MAPPING: Record<string, string> = {
  // Claude 4.5 系列
  'claude-4.5-sonnet': 'claude-sonnet-4-5-20250929',
  'claude-4-5-sonnet': 'claude-sonnet-4-5-20250929',
  'claude-sonnet-4.5': 'claude-sonnet-4-5-20250929',

  // Claude 3.5 系列
  'claude-3.5-sonnet': 'claude-3-5-sonnet-20241022',
  'claude-3-5-sonnet-latest': 'claude-3-5-sonnet-20241022',

  // Claude 3 系列保持不变
  'claude-3-5-sonnet-20241022': 'claude-3-5-sonnet-20241022',
  'claude-3-opus-20240229': 'claude-3-opus-20240229',
  'claude-3-haiku-20240307': 'claude-3-haiku-20240307',

  // Claude Haiku 4.5
  'claude-haiku-4.5': 'claude-haiku-4-5-20251001',
  'claude-haiku-4-5': 'claude-haiku-4-5-20251001',
};

export class AnthropicApiAdapter {
  private baseUrl: string;
  private apiKey: string;

  constructor(config: AnthropicBackendConfig) {
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
  }

  /**
   * 映射模型名称 - 将标准模型名映射到 API 支持的名称
   */
  private mapModelName(model: string): string {
    // 如果是官方 API,不进行映射
    if (this.baseUrl.includes('anthropic.com')) {
      return model;
    }

    // 使用映射表
    const mapped = MODEL_MAPPING[model];
    if (mapped && mapped !== model) {
      console.info('🔄 Model name mapped:', {
        from: model,
        to: mapped,
      });
      return mapped;
    }

    return model;
  }

  /**
   * 透传请求到官方 Anthropic API
   */
  async sendRequest(request: AnthropicRequest): Promise<AnthropicResponse> {
    const startTime = Date.now();

    // 映射模型名称
    const mappedModel = this.mapModelName(request.model);
    const mappedRequest = { ...request, model: mappedModel };

    console.info('🚀 Forwarding to Anthropic API:', {
      model: mappedRequest.model,
      messages: mappedRequest.messages.length,
      tools: mappedRequest.tools?.length || 0,
      stream: mappedRequest.stream || false,
    });

    try {
      // 根据 base URL 决定使用哪种认证方式
      const isOfficialApi = this.baseUrl.includes('anthropic.com');
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      };

      if (isOfficialApi) {
        // 官方 API 使用 x-api-key
        headers['x-api-key'] = this.apiKey;
      } else {
        // 第三方 API 使用 Authorization header + 模拟 Claude Code 客户端
        headers['Authorization'] = `Bearer ${this.apiKey}`;

        // 添加 Claude Code 客户端标识,绕过第三方 API 的来源检查
        headers['User-Agent'] = 'Claude-Code/1.0.0';
        headers['X-Client-Name'] = 'claude-code';
        headers['X-Client-Version'] = '1.0.0';
      }

      const response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify(mappedRequest),
      });

      const elapsed = Date.now() - startTime;

      if (!response.ok) {
        const errorText = await response.text();
        console.error('❌ Anthropic API error:', {
          status: response.status,
          statusText: response.statusText,
          error: errorText.substring(0, 200),
          elapsed: `${elapsed}ms`,
        });
        throw new Error(`Anthropic API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as AnthropicResponse;

      // 验证响应结构并防御性处理
      if (!data || typeof data !== 'object') {
        console.error('❌ Invalid response format from Anthropic API:', {
          received: typeof data,
          elapsed: `${elapsed}ms`,
        });
        throw new Error('Invalid response format from Anthropic API');
      }

      // 防御性访问响应字段
      const responseInfo = {
        id: data.id || 'unknown',
        stopReason: data.stop_reason || 'unknown',
        contentBlocks: data.content?.length || 0,
        inputTokens: data.usage?.input_tokens || 0,
        outputTokens: data.usage?.output_tokens || 0,
        elapsed: `${elapsed}ms`,
      };

      // 如果缺少关键字段,记录警告
      if (!data.content || !Array.isArray(data.content)) {
        console.warn('⚠️ Response missing content array:', {
          hasContent: !!data.content,
          contentType: typeof data.content,
          responseKeys: Object.keys(data),
        });
      }

      if (!data.usage) {
        console.warn('⚠️ Response missing usage information');
      }

      console.success('✅ Anthropic API response:', responseInfo);

      return data;

    } catch (error) {
      const elapsed = Date.now() - startTime;
      console.error('❌ Anthropic API call failed:', {
        error: error instanceof Error ? error.message : 'Unknown error',
        elapsed: `${elapsed}ms`,
      });
      throw error;
    }
  }

  /**
   * 流式请求支持（可选实现）
   *
   * 注意：流式响应需要特殊处理，当前先实现非流式版本
   * 未来可以扩展支持 SSE 流式响应
   */
  async sendStreamRequest(
    request: AnthropicRequest,
    onChunk: (chunk: any) => void,
    onComplete: () => void,
    onError: (error: Error) => void
  ): Promise<void> {
    console.info('🌊 Streaming to Anthropic API (SSE)');

    try {
      // 映射模型名称
      const mappedModel = this.mapModelName(request.model);
      const mappedRequest = { ...request, model: mappedModel, stream: true };

      const isOfficialApi = this.baseUrl.includes('anthropic.com');
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      };

      if (isOfficialApi) {
        headers['x-api-key'] = this.apiKey;
      } else {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
        // 模拟 Claude Code 客户端
        headers['User-Agent'] = 'Claude-Code/1.0.0';
        headers['X-Client-Name'] = 'claude-code';
        headers['X-Client-Version'] = '1.0.0';
      }

      const response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify(mappedRequest),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Anthropic API error: ${response.status} ${errorText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
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
            if (line.startsWith('data: ')) {
              const data = line.substring(6).trim();
              if (data === '[DONE]') {
                onComplete();
                continue;
              }

              try {
                const parsed = JSON.parse(data);
                onChunk(parsed);
              } catch (error) {
                console.warn('Failed to parse SSE chunk:', data.substring(0, 100));
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

    } catch (error) {
      onError(error instanceof Error ? error : new Error('Stream error'));
    }
  }

  /**
   * 健康检查
   */
  async healthCheck(): Promise<boolean> {
    try {
      const isOfficialApi = this.baseUrl.includes('anthropic.com');
      const headers: Record<string, string> = {
        'anthropic-version': '2023-06-01',
      };

      if (isOfficialApi) {
        headers['x-api-key'] = this.apiKey;
      } else {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
        // 模拟 Claude Code 客户端
        headers['User-Agent'] = 'Claude-Code/1.0.0';
        headers['X-Client-Name'] = 'claude-code';
        headers['X-Client-Version'] = '1.0.0';
      }

      // 简单的健康检查：尝试访问 models 端点
      const response = await fetch(`${this.baseUrl}/v1/models`, {
        method: 'GET',
        headers,
      });

      return response.ok;
    } catch (error) {
      console.error('Anthropic API health check failed:', error);
      return false;
    }
  }
}
