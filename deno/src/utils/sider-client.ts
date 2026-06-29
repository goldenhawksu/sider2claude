/**
 * Sider API 客户端
 * 处理向 Sider AI 的 HTTP 请求和 SSE 响应
 */

import type { SiderParsedResponse, SiderRequest } from '../types/index.ts';
import {
  createAccumulatorCallbacks,
  maskId,
  type SiderStreamCallbacks,
  streamSiderSSE,
} from './sse-line-reader.ts';
import { getEnv } from './env.ts';

// Sider API 配置
const SIDER_API_URL = getEnv('SIDER_API_URL', 'https://sider.ai/api/chat/v1/completions');

/**
 * Sider API 客户端类
 */
export class SiderClient {
  private baseURL: string;
  private timeout: number;

  constructor(options: {
    baseURL?: string;
    timeout?: number;
  } = {}) {
    this.baseURL = options.baseURL || SIDER_API_URL;
    this.timeout = options.timeout || 30000; // 30秒超时
  }

  /**
   * 发起 Sider API 请求并校验为 SSE 响应。流式与累积两条路径共用。
   */
  private async doFetch(request: SiderRequest, authToken: string): Promise<Response> {
    const response = await fetch(this.baseURL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
        'Origin': 'chrome-extension://dhoenijjpgpeimemopealfcbiecgceod',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36 Edg/139.0.0.0',
        'X-Time-Zone': 'Asia/Shanghai',
        'X-App-Version': '5.13.0',
        'X-App-Name': 'ChitChat_Edge_Ext',
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!response.ok) {
      throw new Error(`Sider API error: ${response.status} ${response.statusText}`);
    }

    // 检查是否是 SSE 响应
    const contentType = response.headers.get('content-type');
    if (!contentType?.includes('text/event-stream')) {
      throw new Error('Expected SSE response from Sider API');
    }

    return response;
  }

  /**
   * 调用 Sider API 并把 SSE 响应累积为完整结果（非流式路径）。
   */
  async chat(request: SiderRequest, authToken: string): Promise<SiderParsedResponse> {
    console.log('Calling Sider API:', {
      model: request.model,
      contentLength: request.multi_content[0]?.text?.length || 0,
      hasAuth: !!authToken,
      conversationId: maskId(request.cid),
      hasParentMessage: !!request.parent_message_id,
      toolCount: request.tools?.auto?.length || 0,
    });

    try {
      const response = await this.doFetch(request, authToken);
      const { callbacks, result } = createAccumulatorCallbacks();
      await streamSiderSSE(response, callbacks);

      this.logParsedSummary(result);
      return result;
    } catch (error) {
      console.error('Sider API call failed:', error);
      throw error;
    }
  }

  /**
   * 调用 Sider API 并把 SSE 事件实时分发给回调（流式路径）。
   * 调用方负责把回调映射为下游协议事件，并在结束/出错时收尾。
   */
  async chatStream(
    request: SiderRequest,
    authToken: string,
    callbacks: SiderStreamCallbacks,
  ): Promise<void> {
    console.log('Calling Sider API (stream):', {
      model: request.model,
      contentLength: request.multi_content[0]?.text?.length || 0,
      hasAuth: !!authToken,
      conversationId: maskId(request.cid),
      hasParentMessage: !!request.parent_message_id,
      toolCount: request.tools?.auto?.length || 0,
    });

    const response = await this.doFetch(request, authToken);
    await streamSiderSSE(response, callbacks);
  }

  /**
   * 输出解析结果统计与工具调用完整性检查。
   */
  private logParsedSummary(result: SiderParsedResponse): void {
    console.log('SSE parsing completed:', {
      model: result.model,
      reasoningParts: result.reasoningParts.length,
      textParts: result.textParts.length,
      toolResults: result.toolResults?.length || 0,
      textLength: result.textParts.join('').length,
      conversationId: maskId(result.conversationId),
      toolSummary: result.toolResults?.map((t) => ({
        name: t.toolName,
        status: t.status,
        hasError: !!t.error,
      })) || [],
    });

    if (result.textParts.length === 0) {
      console.warn('No text content received from Sider API');
    }

    if (result.toolResults && result.toolResults.length > 0) {
      const incompleteTools = result.toolResults.filter((t) => t.status !== 'finish');
      if (incompleteTools.length > 0) {
        console.warn('Some tool calls did not complete:', {
          incompleteCount: incompleteTools.length,
          incompleteTools: incompleteTools.map((t) => ({
            name: t.toolName,
            id: maskId(t.toolId),
            status: t.status,
          })),
        });
      }

      const failedTools = result.toolResults.filter((t) => t.error);
      if (failedTools.length > 0) {
        console.warn('Some tool calls failed:', {
          failedCount: failedTools.length,
          failedTools: failedTools.map((t) => ({
            name: t.toolName,
            error: t.error,
          })),
        });
      }
    }
  }
}

/**
 * 默认 Sider 客户端实例
 */
export const siderClient = new SiderClient();
