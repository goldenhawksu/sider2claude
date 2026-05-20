/**
 * Messages API 混合路由。
 *
 * 对外提供 Anthropic Messages 接口：
 * - Claude 普通对话优先交给 Sider。
 * - Claude Code/MCP 工具调用等能力缺口交给 DeepSeek Anthropic 兼容端。
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { requireAuth, getAuthInfo } from '../middleware/auth';
import type {
  AnthropicError,
  AnthropicRequest,
  AnthropicResponse,
  AnthropicResponseContent,
} from '../types';
import {
  convertAnthropicToSider,
  convertAnthropicToSiderAsync,
  validateAnthropicRequest,
} from '../utils/request-converter';
import { siderClient } from '../utils/sider-client';
import {
  convertSiderToAnthropic,
  createErrorResponse,
  getSessionHeaders,
} from '../utils/response-converter';
import {
  cleanupExpiredConversations,
  getConversationStats,
} from '../utils/conversation-manager';
import {
  cleanupExpiredSiderSessions,
  getSiderSessionStats,
} from '../utils/sider-session-manager';
import {
  getBackendDisplayName,
  loadBackendConfig,
  type Backend,
} from '../config/backends';
import { RouterEngine } from '../routing/router-engine';
import { AnthropicApiAdapter } from '../adapters/anthropic-adapter';
import { consola } from 'consola';

const messagesRouter = new Hono();

const config = loadBackendConfig();
const routerEngine = new RouterEngine(config);
const capabilityAdapter = config.deepseek.enabled
  ? new AnthropicApiAdapter(config.deepseek)
  : null;

messagesRouter.use('*', requireAuth);

messagesRouter.post('/', async (c: Context) => {
  try {
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

    const anthropicRequest = await c.req.json() as AnthropicRequest;
    consola.info('Received Anthropic request:', {
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

      consola.success(`Request completed via ${getBackendDisplayName(selectedBackend)}`);
    } catch (error) {
      consola.error(`${getBackendDisplayName(decision.backend)} failed:`, error);

      if (!decision.allowFallback || !config.routing.autoFallback) {
        throw error;
      }

      const fallbackBackend: Backend = decision.backend === 'sider' ? 'deepseek' : 'sider';
      consola.warn(`Attempting fallback to ${getBackendDisplayName(fallbackBackend)}`);

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

    if (anthropicRequest.stream) {
      return createStreamingResponse(response);
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
    consola.error('Messages API error:', error);

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

    if (error instanceof Error) {
      return c.json(createErrorResponse(error, 'unknown'), 500);
    }

    return c.json({
      type: 'error',
      error: {
        type: 'api_error',
        message: 'Internal server error',
      },
    } satisfies AnthropicError, 500);
  }
});

messagesRouter.post('/count_tokens', async (c: Context) => {
  try {
    const body = await c.req.json();

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
    return c.json({
      input_tokens: Math.ceil(totalLength / 4),
    });
  } catch (error) {
    consola.error('Token count error:', error);
    return c.json({
      type: 'error',
      error: {
        type: 'api_error',
        message: 'Token counting failed',
      },
    } satisfies AnthropicError, 500);
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
    consola.error('Failed to get conversation stats:', error);
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
    consola.error('Failed to cleanup conversations:', error);
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
    consola.error('Failed to get Sider session stats:', error);
    return c.json({ error: 'Failed to get Sider sessions' }, 500);
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
    consola.error('Failed to cleanup Sider sessions:', error);
    return c.json({ error: 'Failed to cleanup sider sessions' }, 500);
  }
});

async function callSider(
  anthropicRequest: AnthropicRequest,
  authToken: string,
  conversationId?: string,
  parentMessageId?: string,
): Promise<AnthropicResponse> {
  let siderRequest;
  const siderAuthToken = config.sider.authToken || authToken;

  if (conversationId) {
    try {
      siderRequest = await convertAnthropicToSiderAsync(
        anthropicRequest,
        siderAuthToken,
        conversationId,
      );
    } catch (error) {
      consola.warn('Failed to get Sider conversation history, using basic conversion:', error);
      siderRequest = convertAnthropicToSider(anthropicRequest, conversationId);
    }
  } else {
    siderRequest = convertAnthropicToSider(anthropicRequest, conversationId);
  }

  if (parentMessageId) {
    siderRequest.parent_message_id = parentMessageId;
  }

  const siderResponse = await siderClient.chat(siderRequest, siderAuthToken);
  return convertSiderToAnthropic(siderResponse, anthropicRequest.model);
}

function createStreamingResponse(response: AnthropicResponse) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        send({
          type: 'message_start',
          message: {
            id: response.id,
            type: 'message',
            role: 'assistant',
            content: [],
            model: response.model,
            stop_reason: null,
            usage: { input_tokens: response.usage.input_tokens, output_tokens: 0 },
          },
        });

        response.content.forEach((block, index) => {
          streamContentBlock(block, index, send);
        });

        send({
          type: 'message_delta',
          delta: { stop_reason: response.stop_reason || 'end_turn' },
          usage: { output_tokens: response.usage.output_tokens },
        });
        send({ type: 'message_stop' });
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'X-Accel-Buffering': 'no',
    },
  });
}

function streamContentBlock(
  block: AnthropicResponseContent,
  index: number,
  send: (event: unknown) => void,
) {
  if (block.type === 'text') {
    send({
      type: 'content_block_start',
      index,
      content_block: { type: 'text', text: '' },
    });

    if (block.text) {
      send({
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: block.text },
      });
    }

    send({ type: 'content_block_stop', index });
    return;
  }

  if (block.type === 'thinking') {
    send({
      type: 'content_block_start',
      index,
      content_block: {
        type: 'thinking',
        thinking: '',
        ...(block.signature ? { signature: block.signature } : {}),
      },
    });

    if (block.thinking) {
      send({
        type: 'content_block_delta',
        index,
        delta: { type: 'thinking_delta', thinking: block.thinking },
      });
    }

    if (block.signature) {
      send({
        type: 'content_block_delta',
        index,
        delta: { type: 'signature_delta', signature: block.signature },
      });
    }

    send({ type: 'content_block_stop', index });
    return;
  }

  if (block.type === 'redacted_thinking') {
    send({
      type: 'content_block_start',
      index,
      content_block: { type: 'redacted_thinking', data: block.data },
    });
    send({ type: 'content_block_stop', index });
    return;
  }

  send({
    type: 'content_block_start',
    index,
    content_block: {
      type: 'tool_use',
      id: block.id,
      name: block.name,
      input: {},
    },
  });
  send({
    type: 'content_block_delta',
    index,
    delta: {
      type: 'input_json_delta',
      partial_json: JSON.stringify(block.input || {}),
    },
  });
  send({ type: 'content_block_stop', index });
}

export { messagesRouter as hybridMessagesRouter };
