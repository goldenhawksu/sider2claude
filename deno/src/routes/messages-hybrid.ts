/**
 * Messages API 混合路由。
 *
 * 对外提供 Anthropic Messages 接口：
 * - Claude 普通对话优先交给 Sider。
 * - Claude Code/MCP 工具调用等能力缺口交给 DeepSeek Anthropic 兼容端。
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { getAuthInfo, requireAuth } from '../middleware/auth.ts';
import type {
  AnthropicError,
  AnthropicRequest,
  AnthropicResponse,
} from '../types/anthropic.ts';
import type { SiderRequest } from '../types/sider.ts';
import {
  convertAnthropicToSider,
  convertAnthropicToSiderAsync,
  validateAnthropicRequest,
} from '../utils/request-converter.ts';
import { siderClient } from '../utils/sider-client.ts';
import {
  convertSiderToAnthropic,
  createErrorResponse,
  getSessionHeaders,
} from '../utils/response-converter.ts';
import {
  cleanupExpiredConversations,
  getConversationStats,
} from '../utils/conversation-manager.ts';
import {
  cleanupExpiredSiderSessions,
  getSiderSessionStats,
} from '../utils/sider-session-manager.ts';
import { type Backend, getBackendDisplayName, loadBackendConfig } from '../config/backends.ts';
import { RouterEngine } from '../routing/router-engine.ts';
import { AnthropicApiAdapter } from '../adapters/anthropic-adapter.ts';

const messagesRouter = new Hono();

const config = loadBackendConfig();
const routerEngine = new RouterEngine(config);
const capabilityAdapter = config.deepseek.enabled ? new AnthropicApiAdapter(config.deepseek) : null;

messagesRouter.use('*', requireAuth);

messagesRouter.post('/', async (c: Context) => {
  try {
    const auth = getAuthInfo(c);
    if (!auth) {
      return c.json(
        {
          type: 'error',
          error: {
            type: 'authentication_error',
            message: 'Authentication required',
          },
        } satisfies AnthropicError,
        401,
      );
    }

    const anthropicRequest = await c.req.json() as AnthropicRequest;
    console.log('Received Anthropic request:', {
      model: anthropicRequest.model,
      messages: anthropicRequest.messages?.length || 0,
      tools: anthropicRequest.tools?.length || 0,
      stream: !!anthropicRequest.stream,
    });

    validateAnthropicRequest(anthropicRequest);

    let conversationId = c.req.query('cid') || c.req.header('X-Conversation-ID');
    const parentMessageId = c.req.header('X-Parent-Message-ID');

    if (!conversationId && anthropicRequest.messages.length > 1) {
      const hasAssistantMessage = anthropicRequest.messages.some((msg) => msg.role === 'assistant');
      if (hasAssistantMessage) {
        conversationId = 'continuous-conversation';
      }
    }

    const decision = routerEngine.decide(anthropicRequest, conversationId);

    // 流式请求走端到端真流式路径。SSE 一旦开始吐字无法换后端，故流式不做后端 fallback
    // （延迟优先，这是 SSE 代理的通行做法）；上游失败时在流内发 error 事件。
    if (anthropicRequest.stream) {
      return await handleStreamingRequest(
        anthropicRequest,
        auth.token,
        decision.backend,
        conversationId,
        parentMessageId,
      );
    }

    let selectedBackend: Backend = decision.backend;
    let response: AnthropicResponse;

    try {
      if (decision.backend === 'deepseek') {
        if (!capabilityAdapter) {
          throw new Error('DeepSeek capability backend is not configured');
        }

        response = await capabilityAdapter.sendRequest({
          ...anthropicRequest,
          stream: false,
        });

        if (conversationId) {
          routerEngine.recordSessionBackend(conversationId, 'deepseek');
        }
      } else {
        response = await callSider(anthropicRequest, auth.token, conversationId, parentMessageId);

        if (conversationId || response.sider_session?.conversation_id) {
          routerEngine.recordSessionBackend(
            conversationId || response.sider_session!.conversation_id,
            'sider',
          );
        }
      }

      console.log(`Request completed via ${getBackendDisplayName(selectedBackend)}`);
    } catch (error) {
      console.error(`${getBackendDisplayName(decision.backend)} failed:`, error);

      if (!decision.allowFallback || !config.routing.autoFallback) {
        throw error;
      }

      const fallbackBackend: Backend = decision.backend === 'sider' ? 'deepseek' : 'sider';
      console.warn(`Attempting fallback to ${getBackendDisplayName(fallbackBackend)}`);

      if (fallbackBackend === 'deepseek' && capabilityAdapter) {
        response = await capabilityAdapter.sendRequest({ ...anthropicRequest, stream: false });
        selectedBackend = 'deepseek';
        if (conversationId) {
          routerEngine.recordSessionBackend(conversationId, 'deepseek');
        }
      } else if (fallbackBackend === 'sider' && config.sider.enabled) {
        response = await callSider(anthropicRequest, auth.token, conversationId, parentMessageId);
        selectedBackend = 'sider';
      } else {
        throw error;
      }
    }

    const jsonResponse = c.json(response);
    if (selectedBackend === 'sider' && response.sider_session?.message_ids) {
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

    if (config.routing.debugMode) {
      jsonResponse.headers.set('X-Backend-Used', selectedBackend);
      jsonResponse.headers.set('X-Routing-Rule', decision.ruleId);
    }

    return jsonResponse;
  } catch (error) {
    console.error('Messages API error:', error);

    if (
      error instanceof Error && (
        error.message.includes('Missing required field') ||
        error.message.includes('Invalid') ||
        error.message.includes('cannot be empty')
      )
    ) {
      return c.json(
        {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: error.message,
          },
        } satisfies AnthropicError,
        400,
      );
    }

    if (error instanceof Error) {
      return c.json(createErrorResponse(error, 'unknown'), 500);
    }

    return c.json(
      {
        type: 'error',
        error: {
          type: 'api_error',
          message: 'Internal server error',
        },
      } satisfies AnthropicError,
      500,
    );
  }
});

messagesRouter.post('/count_tokens', async (c: Context) => {
  try {
    const body = await c.req.json();

    try {
      validateAnthropicRequest(body as AnthropicRequest);
    } catch (validationError) {
      return c.json(
        {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: validationError instanceof Error ? validationError.message : 'Invalid request',
          },
        } satisfies AnthropicError,
        400,
      );
    }

    const totalLength = JSON.stringify(body.messages || []).length;
    return c.json({
      input_tokens: Math.ceil(totalLength / 4),
    });
  } catch (error) {
    console.error('Token count error:', error);
    return c.json(
      {
        type: 'error',
        error: {
          type: 'api_error',
          message: 'Token counting failed',
        },
      } satisfies AnthropicError,
      500,
    );
  }
});

messagesRouter.get('/backends/status', (c: Context) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    backends: {
      sider: {
        enabled: config.sider.enabled,
        available: !!config.sider.authToken,
      },
      deepseek: {
        enabled: config.deepseek.enabled,
        available: !!config.deepseek.apiKey,
        baseUrl: config.deepseek.baseUrl,
        model: config.deepseek.model,
      },
    },
    routing: {
      defaultBackend: config.routing.defaultBackend,
      autoFallback: config.routing.autoFallback,
      preferSiderForSimpleChat: config.routing.preferSiderForSimpleChat,
      debugMode: config.routing.debugMode,
    },
    stats: routerEngine.getStats(),
  });
});

messagesRouter.get('/conversations', (c: Context) => {
  try {
    return c.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      conversations: getConversationStats(),
    });
  } catch (error) {
    console.error('Failed to get conversation stats:', error);
    return c.json({ error: 'Failed to get conversation stats' }, 500);
  }
});

messagesRouter.post('/conversations/cleanup', (c: Context) => {
  try {
    const cleaned = cleanupExpiredConversations(1);
    return c.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      cleanedConversations: cleaned,
    });
  } catch (error) {
    console.error('Failed to cleanup conversations:', error);
    return c.json({ error: 'Failed to cleanup conversations' }, 500);
  }
});

messagesRouter.get('/sider-sessions', (c: Context) => {
  try {
    return c.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      sider_sessions: getSiderSessionStats(),
    });
  } catch (error) {
    console.error('Failed to get Sider session stats:', error);
    return c.json({ error: 'Failed to get Sider session stats' }, 500);
  }
});

messagesRouter.post('/sider-sessions/cleanup', (c: Context) => {
  try {
    const cleaned = cleanupExpiredSiderSessions(2);
    return c.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      cleanedSiderSessions: cleaned,
    });
  } catch (error) {
    console.error('Failed to cleanup Sider sessions:', error);
    return c.json({ error: 'Failed to cleanup sider sessions' }, 500);
  }
});

function isThinkingEnabled(request: AnthropicRequest): boolean {
  return request.thinking?.type === 'enabled';
}

async function buildSiderRequest(
  anthropicRequest: AnthropicRequest,
  authToken: string,
  conversationId?: string,
  parentMessageId?: string,
): Promise<{ siderRequest: SiderRequest; siderAuthToken: string }> {
  let siderRequest: SiderRequest;
  const siderAuthToken = config.sider.authToken || authToken;

  if (conversationId) {
    try {
      siderRequest = await convertAnthropicToSiderAsync(
        anthropicRequest,
        siderAuthToken,
        conversationId,
      );
    } catch (error) {
      console.warn('Failed to get Sider conversation history, using basic conversion:', error);
      siderRequest = convertAnthropicToSider(anthropicRequest, conversationId);
    }
  } else {
    siderRequest = convertAnthropicToSider(anthropicRequest, conversationId);
  }

  if (parentMessageId) {
    siderRequest.parent_message_id = parentMessageId;
  }

  return { siderRequest, siderAuthToken };
}

async function callSider(
  anthropicRequest: AnthropicRequest,
  authToken: string,
  conversationId?: string,
  parentMessageId?: string,
): Promise<AnthropicResponse> {
  const { siderRequest, siderAuthToken } = await buildSiderRequest(
    anthropicRequest,
    authToken,
    conversationId,
    parentMessageId,
  );

  const siderResponse = await siderClient.chat(siderRequest, siderAuthToken);
  return convertSiderToAnthropic(siderResponse, anthropicRequest.model, {
    includeThinking: isThinkingEnabled(anthropicRequest),
  });
}

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-store, must-revalidate',
  'Connection': 'keep-alive',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'X-Accel-Buffering': 'no',
};

function generateStreamMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

/**
 * 流式请求分流：按路由决策选定后端，进入对应的真流式实现。
 */
async function handleStreamingRequest(
  anthropicRequest: AnthropicRequest,
  authToken: string,
  backend: Backend,
  conversationId?: string,
  parentMessageId?: string,
): Promise<Response> {
  if (backend === 'deepseek') {
    if (!capabilityAdapter) {
      throw new Error('DeepSeek capability backend is not configured');
    }
    if (conversationId) {
      routerEngine.recordSessionBackend(conversationId, 'deepseek');
    }
    return createDeepSeekStreamingResponse(capabilityAdapter, anthropicRequest);
  }

  if (conversationId) {
    routerEngine.recordSessionBackend(conversationId, 'sider');
  }

  const { siderRequest, siderAuthToken } = await buildSiderRequest(
    anthropicRequest,
    authToken,
    conversationId,
    parentMessageId,
  );

  return createTrueSiderStreamingResponse(
    siderRequest,
    siderAuthToken,
    anthropicRequest.model,
    isThinkingEnabled(anthropicRequest),
  );
}

/**
 * Sider 真流式：用 content block 状态机把 Sider SSE 事件实时映射为 Anthropic SSE。
 * reasoning_content -> thinking 块（仅在请求开启 thinking 时）；text -> text 块。
 */
function createTrueSiderStreamingResponse(
  siderRequest: SiderRequest,
  siderAuthToken: string,
  outwardModel: string,
  includeThinking: boolean,
): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      const safeClose = () => {
        if (!closed) {
          closed = true;
          controller.close();
        }
      };

      const messageId = generateStreamMessageId();
      let started = false;
      let blockIndex = -1;
      let currentBlock: 'thinking' | 'text' | null = null;
      let outputChars = 0;

      const ensureStart = () => {
        if (started) return;
        started = true;
        send({
          type: 'message_start',
          message: {
            id: messageId,
            type: 'message',
            role: 'assistant',
            content: [],
            model: outwardModel,
            stop_reason: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        });
      };

      const closeBlock = () => {
        if (currentBlock !== null) {
          send({ type: 'content_block_stop', index: blockIndex });
          currentBlock = null;
        }
      };

      const openBlock = (type: 'thinking' | 'text') => {
        closeBlock();
        blockIndex += 1;
        currentBlock = type;
        send({
          type: 'content_block_start',
          index: blockIndex,
          content_block: type === 'thinking'
            ? { type: 'thinking', thinking: '' }
            : { type: 'text', text: '' },
        });
      };

      try {
        await siderClient.chatStream(siderRequest, siderAuthToken, {
          onMessageStart() {
            ensureStart();
          },
          onReasoningContent(data) {
            if (!includeThinking) return;
            const text = data.reasoning_content?.text;
            if (!text) return;
            ensureStart();
            if (currentBlock !== 'thinking') {
              openBlock('thinking');
            }
            send({
              type: 'content_block_delta',
              index: blockIndex,
              delta: { type: 'thinking_delta', thinking: text },
            });
          },
          onText(data) {
            if (!data.text) return;
            ensureStart();
            if (currentBlock !== 'text') {
              openBlock('text');
            }
            outputChars += data.text.length;
            send({
              type: 'content_block_delta',
              index: blockIndex,
              delta: { type: 'text_delta', text: data.text },
            });
          },
        });

        // 流正常结束：极端情况下没有任何事件，也要先发 message_start。
        ensureStart();
        closeBlock();
        send({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: Math.ceil(outputChars / 4) },
        });
        send({ type: 'message_stop' });
        safeClose();
      } catch (error) {
        console.error('Sider streaming failed:', error);
        ensureStart();
        closeBlock();
        send({
          type: 'error',
          error: {
            type: 'api_error',
            message: error instanceof Error ? error.message : 'Sider streaming error',
          },
        });
        safeClose();
      }
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}

/**
 * DeepSeek 真流式：DeepSeek 的 /v1/messages 原生输出 Anthropic SSE，直接透传上游事件。
 */
function createDeepSeekStreamingResponse(
  adapter: AnthropicApiAdapter,
  request: AnthropicRequest,
): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      const safeClose = () => {
        if (!closed) {
          closed = true;
          controller.close();
        }
      };

      try {
        await adapter.sendStreamRequest(
          request,
          (chunk) => send(chunk),
          () => safeClose(),
          (error) => {
            send({
              type: 'error',
              error: {
                type: 'api_error',
                message: error.message,
              },
            });
            safeClose();
          },
        );
      } catch (error) {
        send({
          type: 'error',
          error: {
            type: 'api_error',
            message: error instanceof Error ? error.message : 'DeepSeek streaming error',
          },
        });
        safeClose();
      }
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}

export { messagesRouter as hybridMessagesRouter };
