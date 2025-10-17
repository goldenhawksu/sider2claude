

/**
 * Messages API 路由
 * 实现 Anthropic API 兼容的 /v1/messages 端点
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { requireAuth, getAuthInfo } from '../middleware/auth.ts';
import type { AnthropicRequest, AnthropicError } from '../types/index.ts';
import { convertAnthropicToSider, convertAnthropicToSiderAsync, validateAnthropicRequest } from '../utils/request-converter.ts';
import { siderClient } from '../utils/sider-client.ts';
import { convertSiderToAnthropic, createErrorResponse, getSessionHeaders } from '../utils/response-converter.ts';
import { getConversationStats, cleanupExpiredConversations } from '../utils/conversation-manager.ts';
import { getSiderSessionStats, cleanupExpiredSiderSessions } from '../utils/sider-session-manager.ts';
import { consola } from 'consola';

const messagesRouter = new Hono();

// 应用认证中间件
messagesRouter.use('*', requireAuth);

/**
 * POST /v1/messages
 * 核心端点：将 Anthropic API 请求转换为 Sider API 调用
 */
messagesRouter.post('/', async (c: Context) => {
  try {
    // 获取认证信息
    const auth = getAuthInfo(c);
    if (!auth) {
      return c.json({
        type: 'error',
        error: {
          type: 'authentication_error',
          message: 'Authentication required',
        },
      } satisfies AnthropicError, 401);
    }

    // 解析请求体
    const anthropicRequest = await c.req.json() as AnthropicRequest;
    
    consola.info('Received Anthropic API request:', {
      model: anthropicRequest.model,
      messageCount: anthropicRequest.messages?.length || 0,
      hasMaxTokens: !!anthropicRequest.max_tokens,
      hasTools: !!anthropicRequest.tools && anthropicRequest.tools.length > 0,
      toolCount: anthropicRequest.tools?.length || 0,
      hasSystem: !!anthropicRequest.system,
      stream: !!anthropicRequest.stream,
    },"@@@",anthropicRequest);

    // 打印会话历史摘要（用于调试会话保持）
    if (anthropicRequest.messages.length > 1) {
      consola.info('Conversation history:', {
        totalMessages: anthropicRequest.messages.length,
        roles: anthropicRequest.messages.map(m => m.role),
        lastUserMessage: anthropicRequest.messages
          .filter(m => m.role === 'user')
          .pop()?.content?.toString()?.substring(0, 50) + '...'
      });
    }

    // 验证请求格式
    validateAnthropicRequest(anthropicRequest);

    // 1. 检查是否提供了会话ID（支持真正的会话保持）
    // 支持多种会话ID来源：查询参数、header、消息历史推断
    let conversationId = c.req.query('cid') || c.req.header('X-Conversation-ID');
    let parentMessageId = c.req.header('X-Parent-Message-ID'); // 支持直接传递父消息ID
    
    // 如果没有明确的会话ID，尝试从消息历史中推断
    if (!conversationId && anthropicRequest.messages.length > 1) {
      // 检查是否有assistant消息，如果有说明这是多轮对话
      const hasAssistantMessage = anthropicRequest.messages.some(msg => msg.role === 'assistant');
      if (hasAssistantMessage) {
        // 生成一个基于时间的会话ID，或者使用固定值表示连续对话
        conversationId = 'continuous-conversation';
        consola.info('Inferred continuous conversation from message history');
      }
    }
    
    // 2. 将 Anthropic 请求转换为 Sider 格式
    let siderRequest;
    
    if (conversationId && anthropicRequest.messages.length > 1) {
      // 使用真正的 Sider 会话历史
      consola.info('Attempting to use real conversation history:', {
        conversationId: conversationId.substring(0, 10) + '...',
        messageCount: anthropicRequest.messages.length,
        hasParentMessageId: !!parentMessageId,
      });
      
      try {
        siderRequest = await convertAnthropicToSiderAsync(
          anthropicRequest, 
          auth.token, 
          conversationId
        );
        
        // 如果客户端直接提供了父消息ID，优先使用客户端的
        if (parentMessageId) {
          siderRequest.parent_message_id = parentMessageId;
          consola.info('Using client-provided parent message ID:', {
            parentMessageId: parentMessageId.substring(0, 12) + '...',
          });
        }
      } catch (error) {
        consola.warn('Failed to get conversation history, using fallback:', error);
        siderRequest = convertAnthropicToSider(anthropicRequest, conversationId);
        
        // 如果客户端提供了父消息ID，使用它
        if (parentMessageId) {
          siderRequest.parent_message_id = parentMessageId;
        }
      }
    } else {
      // 新会话或没有会话ID，使用基本模式
      siderRequest = convertAnthropicToSider(anthropicRequest, conversationId);
      
      // 如果客户端提供了父消息ID，使用它（即使没有会话ID）
      if (parentMessageId) {
        siderRequest.parent_message_id = parentMessageId;
        consola.info('Using client-provided parent message ID for new conversation:', {
          parentMessageId: parentMessageId.substring(0, 12) + '...',
        });
      }
    }

    // 3. 调用 Sider API
    consola.info('Calling Sider API...');

    // 使用环境变量中的 SIDER_AUTH_TOKEN (如果配置了),否则使用客户端提供的 token
    const siderAuthToken = process.env.SIDER_AUTH_TOKEN || Bun?.env?.SIDER_AUTH_TOKEN || Deno?.env?.get?.('SIDER_AUTH_TOKEN') || auth.token;

    consola.debug('Using Sider auth token:', {
      fromEnv: !!(process.env.SIDER_AUTH_TOKEN || Bun?.env?.SIDER_AUTH_TOKEN || Deno?.env?.get?.('SIDER_AUTH_TOKEN')),
      tokenPrefix: siderAuthToken.substring(0, 8) + '...'
    });

    const siderResponse = await siderClient.chat(siderRequest, siderAuthToken);

    // 4. 将 Sider 响应转换为 Anthropic 格式
    const anthropicResponse = convertSiderToAnthropic(siderResponse, anthropicRequest.model);

    // 获取会话信息响应头
    const sessionHeaders = getSessionHeaders(siderResponse);

    consola.info('Request completed successfully:', {
      responseId: anthropicResponse.id,
      outputTokens: anthropicResponse.usage.output_tokens,
      isStreaming: !!anthropicRequest.stream,
      sessionHeaders: Object.keys(sessionHeaders),
    });

    // 5. 根据是否需要流式响应返回不同格式
    if (anthropicRequest.stream) {
      // 返回流式响应
      return createStreamingResponse(c, anthropicResponse);
    } else {
      // 返回标准 JSON 响应，包含会话信息头
      const response = c.json(anthropicResponse);
      
      // 添加会话信息响应头
      Object.entries(sessionHeaders).forEach(([key, value]) => {
        response.headers.set(key, value);
      });
      
      return response;
    }

  } catch (error) {
    consola.error('Messages API error:', error);
    
    // 如果是验证错误，返回 400
    if (error instanceof Error && (
      error.message.includes('Missing required field') ||
      error.message.includes('Invalid') ||
      error.message.includes('cannot be empty')
    )) {
      return c.json({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: error.message,
        },
      } satisfies AnthropicError, 400);
    }

    // 如果是 Sider API 错误，创建错误响应
    if (error instanceof Error) {
      const errorResponse = createErrorResponse(error, 'unknown');
      return c.json(errorResponse, 500);
    }

    // 通用错误
    return c.json({
      type: 'error',
      error: {
        type: 'api_error',
        message: 'Internal server error',
      },
    } satisfies AnthropicError, 500);
  }
});

/**
 * POST /v1/messages/count_tokens
 * Token 计数端点 (可选实现)
 */
messagesRouter.post('/count_tokens', async (c: Context) => {
  try {
    const body = await c.req.json();
    
    // 简单的 token 计数估算 (后续可以使用 gpt-tokenizer)
    const totalLength = JSON.stringify(body.messages || []).length;
    const estimatedTokens = Math.ceil(totalLength / 4); // 粗略估算

    return c.json({
      input_tokens: estimatedTokens,
    });

  } catch (error) {
    console.error('Token count error:', error);
    
    return c.json({
      type: 'error',
      error: {
        type: 'api_error',
        message: 'Token counting failed',
      },
    } satisfies AnthropicError, 500);
  }
});

/**
 * 创建流式响应
 * 参考 copilot-api 的实现，使用标准的 SSE 格式
 */
function createStreamingResponse(_c: Context, response: any) {
  const text = response.content[0]?.text || '';
  
  consola.debug('Creating streaming response:', {
    responseId: response.id,
    textLength: text.length,
    model: response.model
  });

  // 创建标准的 SSE 流
  const encoder = new TextEncoder();
  
  const stream = new ReadableStream({
    start(controller) {
      try {
        // 1. 发送 message_start 事件
        const messageStart = {
          type: 'message_start',
          message: {
            id: response.id,
            type: 'message',
            role: 'assistant',
            content: [],
            model: response.model,
            stop_reason: null,
            usage: { input_tokens: response.usage.input_tokens, output_tokens: 0 }
          }
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(messageStart)}\n\n`));

        // 2. 发送 content_block_start 事件
        const contentBlockStart = {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' }
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(contentBlockStart)}\n\n`));

        // 3. 发送文本内容 - 改为按词分割而不是按字符
        if (text) {
          const words = text.split(/(\s+)/); // 保留空格
          
          words.forEach((word: string, index: number) => {
            setTimeout(() => {
              const contentBlockDelta = {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: word }
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(contentBlockDelta)}\n\n`));

              // 如果是最后一个词，发送结束事件
              if (index === words.length - 1) {
                setTimeout(() => {
                  // content_block_stop
                  const contentBlockStop = {
                    type: 'content_block_stop',
                    index: 0
                  };
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(contentBlockStop)}\n\n`));

                  // message_delta (final usage)
                  const messageDelta = {
                    type: 'message_delta',
                    delta: { stop_reason: 'end_turn' },
                    usage: { output_tokens: response.usage.output_tokens }
                  };
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(messageDelta)}\n\n`));

                  // message_stop
                  const messageStop = { type: 'message_stop' };
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(messageStop)}\n\n`));

                  // 结束流
                  controller.close();
                }, 100);
              }
            }, index * 150); // 每150ms发送一个词
          });
        } else {
          // 如果没有文本内容，直接结束
          const messageStop = { type: 'message_stop' };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(messageStop)}\n\n`));
          controller.close();
        }

      } catch (error) {
        consola.error('Streaming error:', error);
        controller.error(error);
      }
    }
  });

  // 设置标准的 SSE 响应头
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'X-Accel-Buffering': 'no', // 禁用 Nginx 缓冲
    }
  });
}

// 调试接口：查看会话状态
messagesRouter.get('/conversations', async (c: Context) => {
  try {
    const stats = getConversationStats();
    
    consola.info('Conversation stats requested:', {
      totalConversations: stats.totalConversations,
      requestedBy: getAuthInfo(c)?.token?.substring(0, 20) + '...' || 'unknown'
    });
    
    return c.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      conversations: stats
    });
  } catch (error) {
    consola.error('Failed to get conversation stats:', error);
    return c.json({ error: 'Failed to get conversation stats' }, 500);
  }
});

// 调试接口：清理过期会话
messagesRouter.post('/conversations/cleanup', async (c: Context) => {
  try {
    const cleaned = cleanupExpiredConversations(1); // 清理1小时前的会话
    
    consola.info('Conversation cleanup completed:', {
      cleanedCount: cleaned,
      requestedBy: getAuthInfo(c)?.token?.substring(0, 20) + '...' || 'unknown'
    });
    
    return c.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      cleanedConversations: cleaned
    });
  } catch (error) {
    consola.error('Failed to cleanup conversations:', error);
    return c.json({ error: 'Failed to cleanup conversations' }, 500);
  }
});

// 调试接口：查看 Sider 会话状态
messagesRouter.get('/sider-sessions', async (c: Context) => {
  try {
    const stats = getSiderSessionStats();
    
    consola.info('Sider session stats requested:', {
      totalSessions: stats.totalSessions,
      requestedBy: getAuthInfo(c)?.token?.substring(0, 20) + '...' || 'unknown'
    });
    
    return c.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      sider_sessions: stats
    });
  } catch (error) {
    consola.error('Failed to get Sider session stats:', error);
    return c.json({ error: 'Failed to get Sider session stats' }, 500);
  }
});

// 调试接口：清理过期 Sider 会话
messagesRouter.post('/sider-sessions/cleanup', async (c: Context) => {
  try {
    const cleaned = cleanupExpiredSiderSessions(2); // 清理2小时前的会话
    
    consola.info('Sider session cleanup completed:', {
      cleanedCount: cleaned,
      requestedBy: getAuthInfo(c)?.token?.substring(0, 20) + '...' || 'unknown'
    });
    
    return c.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      cleanedSiderSessions: cleaned
    });
  } catch (error) {
    consola.error('Failed to cleanup Sider sessions:', error);
    return c.json({ error: 'Failed to cleanup Sider sessions' }, 500);
  }
});

export { messagesRouter };
