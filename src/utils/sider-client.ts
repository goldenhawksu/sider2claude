

/**
 * Sider API 客户端
 * 处理向 Sider AI 的 HTTP 请求和 SSE 响应
 */

import type { SiderRequest, SiderSSEResponse, SiderParsedResponse } from '../types';
import { consola } from 'consola';
import { saveSiderSession, getOrCreateContinuousSession } from './sider-session-manager.js';
import { cancelUpstreamReader } from './stream-cancel.js';
import { getEnv } from './env';

// Sider API 配置
const SIDER_API_URL = getEnv('SIDER_API_URL', 'https://sider.ai/api/chat/v1/completions');

/**
 * Sider 在 SSE 内用 `code !== 0` 表达业务失败（如 1135 用量超限），HTTP 状态仍是 200。
 * 这类失败必须显式表达，否则调用方只会收到一个空回复，既无法 fallback 也无法诊断。
 */
export class SiderUpstreamError extends Error {
  constructor(
    message: string,
    public siderCode: number,
    public statusCode: number,
    /**
     * 上游原始 msg（不含本地拼的前缀）。1135 的恢复时长就写在这里面，
     * 单独留一份是为了让下游解析时不必先剥前缀。
     */
    public upstreamMessage = '',
    /** 从 `upstreamMessage` 解析出的上游建议重试间隔（毫秒）；解析不出为 undefined。 */
    public retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'SiderUpstreamError';
  }
}

/**
 * 从上游消息里解析「还要等多久」。
 *
 * 1135 的消息实测长这样，恢复时刻是上游**主动告诉我们的事实**：
 *   You've reached the current usage limit. ... Please try again after 117 minutes.
 * 实测跨度极大（1 / 117 / 261 / 272 分钟），任何硬编码的冷却值都会在两个方向同时
 * 出错：说 1 分钟时白闲置一小时的额度，说 272 分钟时每分钟去撞一次墙。
 *
 * 解析不出返回 undefined，由调用方回退到自己的保守默认值——上游随时可能改文案，
 * 这个函数失效时整套熔断要能退回原来的行为，而不是失去冷却。
 */
const RETRY_AFTER_PATTERN = /after\s+(\d+(?:\.\d+)?)\s*(hours?|hrs?|minutes?|mins?|seconds?|secs?)/i;

export function parseSiderRetryAfterMs(msg: string): number | undefined {
  const match = RETRY_AFTER_PATTERN.exec(msg);
  if (!match) {
    return undefined;
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  const unit = (match[2] ?? '').toLowerCase();
  const factor = unit.startsWith('h') ? 3_600_000 : unit.startsWith('m') ? 60_000 : 1_000;
  return Math.round(value * factor);
}

/**
 * 由 Sider 业务错误码构造错误。消息格式与状态码映射只在这里定义一次：
 * - 1135 用量超限 -> 429（可重试，且带上游给的时长）；
 * - 603 单请求体量超限 -> 413。这是**调用方的输入问题**，不是上游故障；
 *   报 502 会让客户端以为是服务端抖动而去重试，而重试同一个超长载荷必然再失败；
 * - 其余按上游故障 -> 502。
 */
export function siderUpstreamError(code: number, msg: string): SiderUpstreamError {
  return new SiderUpstreamError(
    `Sider upstream error ${code}: ${msg}`,
    code,
    code === 1135 ? 429 : code === 603 ? 413 : 502,
    msg,
    code === 1135 ? parseSiderRetryAfterMs(msg) : undefined,
  );
}

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
   * 调用 Sider API 并解析 SSE 响应
   */
  async chat(request: SiderRequest, authToken: string): Promise<SiderParsedResponse> {
    consola.info('Calling Sider API:', {
      model: request.model,
      contentLength: request.multi_content[0]?.text?.length || 0,
      hasAuth: !!authToken,
      conversationId: maskId(request.cid),
      hasParentMessage: !!request.parent_message_id,
      toolCount: request.tools?.auto?.length || 0,
    });
    
    try {
      // 构建请求
      const response = await fetch(this.baseURL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`,
          'Origin': 'chrome-extension://dhoenijjpgpeimemopealfcbiecgceod',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36 Edg/139.0.0.0',
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

      // 解析 SSE 流
      return await this.parseSSEResponse(response);

    } catch (error) {
      consola.error('Sider API call failed:', error);
      throw error;
    }
  }

  /**
   * 解析 SSE 响应流
   */
  private async parseSSEResponse(response: Response): Promise<SiderParsedResponse> {
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }

    const decoder = new TextDecoder();
    const result: SiderParsedResponse = {
      reasoningParts: [],
      textParts: [],
      toolResults: [], // 初始化工具调用结果数组
      model: '',
    };
    const upstream: { error?: SiderUpstreamError } = {};

    try {
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // 解码数据块
        buffer += decoder.decode(value, { stream: true });
        
        // 按行分割处理
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // 保留最后一个不完整的行

        for (const line of lines) {
          await this.processSSELine(line.trim(), result, upstream);
        }
      }

      // 处理剩余的缓冲区
      if (buffer.trim()) {
        await this.processSSELine(buffer.trim(), result, upstream);
      }

    } finally {
      // 业务错误码等提前退出路径必须 cancel 上游，否则连接会挂到超时才断。
      await cancelUpstreamReader(reader);
    }

    // Sider 用 SSE 内的 code 表达业务失败。只在同时没拿到任何文本时才判定为失败，
    // 避免把「已正常作答 + 附带一条非致命提示」误判成错误。
    if (upstream.error && result.textParts.length === 0) {
      throw upstream.error;
    }

    consola.info('SSE parsing completed:', {
      model: result.model,
      reasoningParts: result.reasoningParts.length,
      textParts: result.textParts.length,
      toolResults: result.toolResults?.length || 0, // 工具调用数量
      textLength: result.textParts.join('').length,
      conversationId: maskId(result.conversationId),
      // 工具调用详细信息
      toolSummary: result.toolResults?.map(t => ({
        name: t.toolName,
        status: t.status,
        hasError: !!t.error
      })) || []
    });

    // 如果没有文本内容，记录警告
    if (result.textParts.length === 0) {
      consola.warn('No text content received from Sider API');
    }

    // 检查工具调用完整性
    if (result.toolResults && result.toolResults.length > 0) {
      const incompleteTools = result.toolResults.filter(t => t.status !== 'finish');
      if (incompleteTools.length > 0) {
        consola.warn('Some tool calls did not complete:', {
          incompleteCount: incompleteTools.length,
          incompleteTools: incompleteTools.map(t => ({
            name: t.toolName,
            id: t.toolId.substring(0, 12) + '...',
            status: t.status
          }))
        });
      }

      const failedTools = result.toolResults.filter(t => t.error);
      if (failedTools.length > 0) {
        consola.warn('Some tool calls failed:', {
          failedCount: failedTools.length,
          failedTools: failedTools.map(t => ({
            name: t.toolName,
            error: t.error
          }))
        });
      }
    }

    return result;
  }

  /**
   * 处理单行 SSE 数据
   */
  private async processSSELine(
    line: string,
    result: SiderParsedResponse,
    upstream: { error?: SiderUpstreamError },
  ): Promise<void> {
    // 跳过空行和注释
    if (!line || line.startsWith(':')) {
      return;
    }

    // 处理 data: 行
    if (line.startsWith('data:')) {
      const dataStr = line.substring(5).trim();
      
      // 检查结束标记
      if (dataStr === '[DONE]') {
        consola.debug('SSE stream completed');
        return;
      }

      try {
        const data = JSON.parse(dataStr) as SiderSSEResponse;
        // consola.debug('Parsed SSE data:', { type: data.data?.type, hasText: !!(data.data as any)?.text });
        
        if (data.code !== 0) {
          consola.warn('Sider API warning:', { code: data.code, msg: data.msg });
          // 保留首个错误：后续事件可能继续到达，但首个错误最接近失败原因。
          upstream.error ??= siderUpstreamError(data.code, data.msg);
          return;
        }

        // 处理不同类型的响应数据
        switch (data.data.type) {
          case 'credit_info':
            // 配额信息和心跳事件属于 Sider 常规流控事件，静默跳过。
            break;

          case 'pulse':
          case 'tag_stream':
            break;

          case 'message_start':
            // 消息开始 - 保存真实的会话信息
            if (data.data.message_start) {
              const { cid, user_message_id, assistant_message_id } = data.data.message_start;
              
              // 保存到结果对象
              result.conversationId = cid;
              result.messageIds = {
                user: user_message_id,
                assistant: assistant_message_id,
              };
              result.model = data.data.model;
              
              // 保存到会话管理器
              saveSiderSession(cid, user_message_id, assistant_message_id, data.data.model);
              
              // 如果是连续对话会话，也更新连续对话状态
              if (cid === 'continuous-conversation' || cid === '') {
                // 更新连续对话会话状态
                const continuousSession = getOrCreateContinuousSession();
                continuousSession.userMessageId = user_message_id;
                continuousSession.assistantMessageId = assistant_message_id;
                continuousSession.model = data.data.model;
                continuousSession.lastActivity = Date.now();
                continuousSession.messageCount += 1;
                
                consola.info('Updated continuous conversation session:', {
                  userMsgId: user_message_id.substring(0, 12) + '...',
                  assistantMsgId: assistant_message_id.substring(0, 12) + '...',
                  messageCount: continuousSession.messageCount,
                });
              }
              
              consola.info('Real Sider session captured:', {
                cid: cid.substring(0, 12) + '...',
                userMsgId: user_message_id.substring(0, 12) + '...',
                assistantMsgId: assistant_message_id.substring(0, 12) + '...',
                model: data.data.model,
              });
            }
            break;

          case 'reasoning_content':
            // 推理内容 (think 模型)
            if (data.data.reasoning_content?.text) {
              result.reasoningParts.push(data.data.reasoning_content.text);
            }
            result.model = data.data.model;
            break;

          case 'text':
            // 最终文本内容
            if (data.data.text) {
              // consola.debug('Adding text part:', data.data.text);
              result.textParts.push(data.data.text);
            } else {
              consola.debug('Received text event but no text content');
            }
            result.model = data.data.model;
            break;

          case 'tool_call_start':
            // 工具调用开始

            if (data.data.tool_call) {
              const toolCall = data.data.tool_call;
              consola.info('Tool call started:', {
                toolId: toolCall.id.substring(0, 12) + '...',
                toolName: toolCall.name,
                status: toolCall.status
              });
              
              // 初始化工具调用结果（如果不存在）
              if (!result.toolResults) {
                result.toolResults = [];
              }
              
              // 查找现有的工具调用记录或创建新的
              let existingTool = result.toolResults.find(t => t.toolId === toolCall.id);
              if (!existingTool) {
                existingTool = {
                  toolName: toolCall.name,
                  toolId: toolCall.id,
                  result: null,
                  status: 'start'
                };
                result.toolResults.push(existingTool);
              }
              existingTool.status = 'start';
            }
            result.model = data.data.model;
            break;

          case 'tool_call_progress':
            // 工具调用进行中

            if (data.data.tool_call) {
              const toolCall = data.data.tool_call;
              consola.debug('Tool call progress:', {
                toolId: toolCall.id.substring(0, 12) + '...',
                toolName: toolCall.name,
                status: toolCall.status,
                hasProgress: !!toolCall.progress
              });
              
              // 更新现有工具调用状态
              if (result.toolResults) {
                const existingTool = result.toolResults.find(t => t.toolId === toolCall.id);
                if (existingTool) {
                  existingTool.status = 'processing';
                  // 如果有进度信息，可以记录到result中
                  if (toolCall.progress) {
                    existingTool.result = { ...existingTool.result, progress: toolCall.progress };
                  }
                }
              }
            }
            result.model = data.data.model;
            break;

          case 'tool_call_result':
            // 工具调用结果

            if (data.data.tool_call) {
              const toolCall = data.data.tool_call;
              consola.info('Tool call completed:', {
                toolId: toolCall.id.substring(0, 12) + '...',
                toolName: toolCall.name,
                status: toolCall.status,
                hasResult: !!toolCall.result,
                hasError: !!toolCall.error
              });
              
              // 更新最终工具调用结果
              if (result.toolResults) {
                const existingTool = result.toolResults.find(t => t.toolId === toolCall.id);
                if (existingTool) {
                  existingTool.status = 'finish';
                  existingTool.result = toolCall.result;
                  if (toolCall.error) {
                    existingTool.error = toolCall.error;
                    consola.warn('Tool call failed:', {
                      toolName: toolCall.name,
                      error: toolCall.error
                    });
                  }
                } else {
                  // 如果没有找到现有记录，创建新的（异常情况）
                  consola.warn('Tool call result received without start event:', toolCall.id);
                  result.toolResults.push({
                    toolName: toolCall.name,
                    toolId: toolCall.id,
                    result: toolCall.result,
                    status: 'finish',
                    ...(toolCall.error && { error: toolCall.error }) // 只在有错误时添加error字段
                  });
                }
              }
            }
            result.model = data.data.model;
            break;

          default:
            consola.debug('Unknown Sider SSE event type:', {
              type: (data.data as any).type || 'unknown',
            });
        }

      } catch (error) {
        consola.warn('Failed to parse Sider SSE data:', {
          dataLength: dataStr.length,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

function maskId(id?: string): string {
  if (!id) {
    return 'new';
  }

  return id.length > 12 ? `${id.substring(0, 12)}...` : id;
}

/**
 * 默认 Sider 客户端实例
 */
export const siderClient = new SiderClient();
