/**
 * Anthropic API 适配器
 * 透传请求到官方 Anthropic API
 */

import type { AnthropicRequest, AnthropicResponse } from '../types/anthropic';
import type { AnthropicBackendConfig } from '../config/backends';
import { consola } from 'consola';

export class AnthropicApiAdapter {
  private baseUrl: string;
  private apiKey: string;

  constructor(config: AnthropicBackendConfig) {
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
  }

  /**
   * 透传请求到官方 Anthropic API
   */
  async sendRequest(request: AnthropicRequest): Promise<AnthropicResponse> {
    const startTime = Date.now();

    consola.info('🚀 Forwarding to Anthropic API:', {
      model: request.model,
      messages: request.messages.length,
      tools: request.tools?.length || 0,
      stream: request.stream || false,
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
        body: JSON.stringify(request),
      });

      const elapsed = Date.now() - startTime;

      if (!response.ok) {
        const errorText = await response.text();
        consola.error('❌ Anthropic API error:', {
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
        consola.error('❌ Invalid response format from Anthropic API:', {
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
        consola.warn('⚠️ Response missing content array:', {
          hasContent: !!data.content,
          contentType: typeof data.content,
          responseKeys: Object.keys(data),
        });
      }

      if (!data.usage) {
        consola.warn('⚠️ Response missing usage information');
      }

      consola.success('✅ Anthropic API response:', responseInfo);

      return data;

    } catch (error) {
      const elapsed = Date.now() - startTime;
      consola.error('❌ Anthropic API call failed:', {
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
    consola.info('🌊 Streaming to Anthropic API (SSE)');

    try {
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
        body: JSON.stringify({ ...request, stream: true }),
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
                consola.warn('Failed to parse SSE chunk:', data.substring(0, 100));
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
      consola.error('Anthropic API health check failed:', error);
      return false;
    }
  }
}
