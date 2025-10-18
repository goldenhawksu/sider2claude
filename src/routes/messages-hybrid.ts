/**
 * Messages API 混合路由版本
 * 智能路由到 Sider AI 或 Anthropic API
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { requireAuth, getAuthInfo } from '../middleware/auth';
import type { AnthropicRequest, AnthropicResponse, AnthropicError } from '../types';
import { convertAnthropicToSider, convertAnthropicToSiderAsync, validateAnthropicRequest } from '../utils/request-converter';
import { siderClient } from '../utils/sider-client';
import { convertSiderToAnthropic, createErrorResponse, getSessionHeaders } from '../utils/response-converter';
import { getConversationStats, cleanupExpiredConversations } from '../utils/conversation-manager';
import { getSiderSessionStats, cleanupExpiredSiderSessions } from '../utils/sider-session-manager';
import { loadBackendConfig, type Backend, getBackendDisplayName } from '../config/backends';
import { RouterEngine } from '../routing/router-engine';
import { AnthropicApiAdapter } from '../adapters/anthropic-adapter';
import { consola } from 'consola';

const messagesRouter = new Hono();

// 加载配置并创建路由引擎
const config = loadBackendConfig();
const routerEngine = new RouterEngine(config);
const anthropicAdapter = config.anthropic.enabled
  ? new AnthropicApiAdapter(config.anthropic)
  : null;

// 应用认证中间件
messagesRouter.use('*', requireAuth);

/**
 * POST /v1/messages
 * 混合路由核心端点
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

    consola.info('📨 Received request:', {
      model: anthropicRequest.model,
      messages: anthropicRequest.messages?.length || 0,
      tools: anthropicRequest.tools?.length || 0,
      stream: !!anthropicRequest.stream,
    });

    // 验证请求格式
    validateAnthropicRequest(anthropicRequest);

    // 提取会话 ID
    let conversationId = c.req.query('cid') || c.req.header('X-Conversation-ID');
    const parentMessageId = c.req.header('X-Parent-Message-ID');

    // 推断连续对话
    if (!conversationId && anthropicRequest.messages.length > 1) {
      const hasAssistantMessage = anthropicRequest.messages.some(msg => msg.role === 'assistant');
      if (hasAssistantMessage) {
        conversationId = 'continuous-conversation';
        consola.debug('Inferred continuous conversation from message history');
      }
    }

    // 🎯 路由决策
    const decision = routerEngine.decide(anthropicRequest, conversationId);

    // 根据决策路由到对应后端
    let response: AnthropicResponse;
    let selectedBackend: Backend = decision.backend;

    try {
      if (decision.backend === 'anthropic') {
        // ============= 路由到 Anthropic API =============
        if (!anthropicAdapter) {
          throw new Error('Anthropic API not configured');
        }

        consola.info(`🤖 Using Anthropic API`);
        response = await anthropicAdapter.sendRequest(anthropicRequest);

        // 记录后端选择
        if (conversationId) {
          routerEngine.recordSessionBackend(conversationId, 'anthropic');
        }

      } else {
        // ============= 路由到 Sider AI =============
        consola.info(`📡 Using Sider AI`);

        // 将 Anthropic 请求转换为 Sider 格式
        let siderRequest;

        if (conversationId && anthropicRequest.messages.length > 1) {
          try {
            siderRequest = await convertAnthropicToSiderAsync(
              anthropicRequest,
              auth.token,
              conversationId
            );

            if (parentMessageId) {
              siderRequest.parent_message_id = parentMessageId;
            }
          } catch (error) {
            consola.warn('Failed to get conversation history, using fallback:', error);
            siderRequest = convertAnthropicToSider(anthropicRequest, conversationId);

            if (parentMessageId) {
              siderRequest.parent_message_id = parentMessageId;
            }
          }
        } else {
          siderRequest = convertAnthropicToSider(anthropicRequest, conversationId);

          if (parentMessageId) {
            siderRequest.parent_message_id = parentMessageId;
          }
        }

        // 调用 Sider API
        const siderAuthToken = process.env.SIDER_AUTH_TOKEN
          || Bun?.env?.SIDER_AUTH_TOKEN
          || (typeof Deno !== 'undefined' ? Deno?.env?.get?.('SIDER_AUTH_TOKEN') : null)
          || auth.token;

        const siderResponse = await siderClient.chat(siderRequest, siderAuthToken);

        // 转换为 Anthropic 格式
        response = convertSiderToAnthropic(siderResponse, anthropicRequest.model);

        // 记录后端选择
        if (conversationId || siderResponse.conversationId) {
          const cid = conversationId || siderResponse.conversationId!;
          routerEngine.recordSessionBackend(cid, 'sider');
        }
      }

      consola.success(`✅ Request completed via ${getBackendDisplayName(selectedBackend)}`);

    } catch (error) {
      consola.error(`❌ ${getBackendDisplayName(decision.backend)} failed:`, error);

      // 🔄 自动降级处理
      if (decision.allowFallback && config.routing.autoFallback) {
        const fallbackBackend: Backend = decision.backend === 'sider' ? 'anthropic' : 'sider';

        consola.warn(`⚠️ Attempting fallback to ${getBackendDisplayName(fallbackBackend)}`);

        try {
          if (fallbackBackend === 'anthropic' && anthropicAdapter) {
            response = await anthropicAdapter.sendRequest(anthropicRequest);
            selectedBackend = 'anthropic';
            if (conversationId) {
              routerEngine.recordSessionBackend(conversationId, 'anthropic');
            }
            consola.success(`✅ Fallback to Anthropic API succeeded`);
          } else if (fallbackBackend === 'sider' && config.sider.enabled) {
            const siderAuthToken = process.env.SIDER_AUTH_TOKEN
              || Bun?.env?.SIDER_AUTH_TOKEN
              || (typeof Deno !== 'undefined' ? Deno?.env?.get?.('SIDER_AUTH_TOKEN') : null)
              || auth.token;

            const siderRequest = await convertAnthropicToSiderAsync(
              anthropicRequest,
              siderAuthToken,
              conversationId
            );

            const siderResponse = await siderClient.chat(siderRequest, siderAuthToken);
            response = convertSiderToAnthropic(siderResponse, anthropicRequest.model);
            selectedBackend = 'sider';

            if (conversationId || siderResponse.conversationId) {
              routerEngine.recordSessionBackend(conversationId || siderResponse.conversationId!, 'sider');
            }
            consola.success(`✅ Fallback to Sider AI succeeded`);
          } else {
            throw new Error('Fallback backend not available');
          }
        } catch (fallbackError) {
          consola.error('❌ Fallback also failed:', fallbackError);
          throw error; // 抛出原始错误
        }
      } else {
        throw error;
      }
    }

    // 返回响应
    if (anthropicRequest.stream) {
      return createStreamingResponse(c, response);
    } else {
      const jsonResponse = c.json(response);

      // 添加会话信息响应头（仅 Sider 后端）
      if (selectedBackend === 'sider' && response.sider_session && response.sider_session.message_ids) {
        const sessionHeaders = getSessionHeaders({
          conversationId: response.sider_session.conversation_id,
          messageIds: response.sider_session.message_ids,
          textParts: [],
          reasoningParts: [],
          model: response.model,
        });

        Object.entries(sessionHeaders).forEach(([key, value]) => {
          jsonResponse.headers.set(key, value);
        });
      }

      // 添加路由信息头（调试用）
      if (config.routing.debugMode) {
        jsonResponse.headers.set('X-Backend-Used', selectedBackend);
        jsonResponse.headers.set('X-Routing-Rule', decision.ruleId);
      }

      return jsonResponse;
    }

  } catch (error) {
    consola.error('Messages API error:', error);

    // 验证错误
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

    // 创建错误响应
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
 */
messagesRouter.post('/count_tokens', async (c: Context) => {
  try {
    const body = await c.req.json();

    // ✅ 验证请求格式（与主端点一致）
    try {
      validateAnthropicRequest(body as AnthropicRequest);
    } catch (validationError) {
      return c.json({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: validationError instanceof Error ? validationError.message : 'Invalid request',
        },
      } satisfies AnthropicError, 400);
    }

    const totalLength = JSON.stringify(body.messages || []).length;
    const estimatedTokens = Math.ceil(totalLength / 4);

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
 * GET /v1/messages/backends/status
 * 后端状态查询
 */
messagesRouter.get('/backends/status', (c: Context) => {
  const stats = routerEngine.getStats();

  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    backends: {
      sider: {
        enabled: config.sider.enabled,
        available: !!config.sider.authToken,
      },
      anthropic: {
        enabled: config.anthropic.enabled,
        available: !!config.anthropic.apiKey,
      },
    },
    routing: {
      defaultBackend: config.routing.defaultBackend,
      autoFallback: config.routing.autoFallback,
      preferSiderForSimpleChat: config.routing.preferSiderForSimpleChat,
      debugMode: config.routing.debugMode,
    },
    stats: stats,
  });
});

/**
 * 创建流式响应
 */
function createStreamingResponse(_c: Context, response: any) {
  const text = response.content[0]?.text || '';

  consola.debug('Creating streaming response:', {
    responseId: response.id,
    textLength: text.length,
  });

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      try {
        // message_start
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

        // content_block_start
        const contentBlockStart = {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' }
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(contentBlockStart)}\n\n`));

        // 按词分割发送
        if (text) {
          const words = text.split(/(\s+)/);

          words.forEach((word: string, index: number) => {
            setTimeout(() => {
              const contentBlockDelta = {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: word }
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(contentBlockDelta)}\n\n`));

              if (index === words.length - 1) {
                setTimeout(() => {
                  // content_block_stop
                  const contentBlockStop = { type: 'content_block_stop', index: 0 };
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(contentBlockStop)}\n\n`));

                  // message_delta
                  const messageDelta = {
                    type: 'message_delta',
                    delta: { stop_reason: 'end_turn' },
                    usage: { output_tokens: response.usage.output_tokens }
                  };
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(messageDelta)}\n\n`));

                  // message_stop
                  const messageStop = { type: 'message_stop' };
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(messageStop)}\n\n`));

                  controller.close();
                }, 100);
              }
            }, index * 150);
          });
        } else {
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

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'X-Accel-Buffering': 'no',
    }
  });
}

// 调试接口
messagesRouter.get('/conversations', async (c: Context) => {
  try {
    const stats = getConversationStats();
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

messagesRouter.post('/conversations/cleanup', async (c: Context) => {
  try {
    const cleaned = cleanupExpiredConversations(1);
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

messagesRouter.get('/sider-sessions', async (c: Context) => {
  try {
    const stats = getSiderSessionStats();
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

messagesRouter.post('/sider-sessions/cleanup', async (c: Context) => {
  try {
    const cleaned = cleanupExpiredSiderSessions(2);
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

export { messagesRouter as hybridMessagesRouter };
