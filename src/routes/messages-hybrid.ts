/**
 * Messages API 混合路由。
 *
 * 对外提供 Anthropic Messages 接口：
 * - Claude 普通对话优先交给 Sider。
 * - Claude Code/MCP 工具调用等能力缺口交给 DeepSeek Anthropic 兼容端。
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { getAuthInfo, requireAuth } from '../middleware/auth';
import type {
  AnthropicError,
  AnthropicRequest,
  AnthropicResponse,
  AnthropicResponseContent,
} from '../types';
import {
  convertAnthropicToSider,
  convertAnthropicToSiderAsync,
  normalizeAnthropicRequest,
  validateAnthropicRequest,
} from '../utils/request-converter';
import { siderClient, SiderUpstreamError } from '../utils/sider-client';
import { convertSiderToAnthropic, getSessionHeaders } from '../utils/response-converter';
import { cleanupExpiredConversations, getConversationStats } from '../utils/conversation-manager';
import { cleanupExpiredSiderSessions, getSiderSessionStats } from '../utils/sider-session-manager';
import { type Backend, getBackendDisplayName, loadBackendConfig } from '../config/backends';
import { RouterEngine } from '../routing/router-engine';
import { AnthropicApiAdapter, AnthropicBackendError } from '../adapters/anthropic-adapter';
import { consola } from 'consola';
import {
  createRequestLogContext,
  logError,
  logInfo,
  logWarn,
  NON_STREAM_SLOW_MS,
  observeDuplicateCandidate,
  type RequestLogContext,
  serializeError,
  STREAM_FIRST_EVENT_SLOW_MS,
  STREAM_TOTAL_SLOW_MS,
} from '../utils/request-observability';

const messagesRouter = new Hono();

const config = loadBackendConfig();
const routerEngine = new RouterEngine(config);
const capabilityAdapter = config.deepseek.enabled ? new AnthropicApiAdapter(config.deepseek) : null;

messagesRouter.use('*', requireAuth);

messagesRouter.post('/', async (c: Context) => {
  const requestStartedAt = Date.now();
  const inboundRequestId = c.req.header('X-Request-ID') || undefined;
  let logContext: RequestLogContext | undefined;
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

    const anthropicRequest = normalizeAnthropicRequest(await c.req.json() as AnthropicRequest);
    logContext = createRequestLogContext(anthropicRequest, inboundRequestId);
    logInfo('request_received', {
      requestId: logContext.requestId,
      requestHash: logContext.requestHash,
      ...logContext.summary,
    });

    validateAnthropicRequest(anthropicRequest);

    const duplicate = observeDuplicateCandidate(
      logContext.requestHash,
      !!anthropicRequest.stream,
    );
    if (duplicate.duplicate) {
      logWarn('duplicate_request_candidate', {
        requestId: logContext.requestId,
        requestHash: logContext.requestHash,
        count: duplicate.count,
        ageMs: duplicate.ageMs,
        previousStreams: duplicate.previousStreams,
        stream: !!anthropicRequest.stream,
        model: anthropicRequest.model,
        messages: anthropicRequest.messages.length,
        tools: anthropicRequest.tools?.length || 0,
      });
    }

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
        }, logContext);

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

    } catch (error) {
      logError('backend_request_failed', {
        requestId: logContext.requestId,
        requestHash: logContext.requestHash,
        backend: decision.backend,
        backendDisplayName: getBackendDisplayName(decision.backend),
        error: serializeError(error),
      }, `${getBackendDisplayName(decision.backend)} failed:`);

      if (!decision.allowFallback || !config.routing.autoFallback) {
        throw error;
      }

      const fallbackBackend: Backend = decision.backend === 'sider' ? 'deepseek' : 'sider';
      logWarn('backend_fallback_attempt', {
        requestId: logContext.requestId,
        requestHash: logContext.requestHash,
        fromBackend: decision.backend,
        toBackend: fallbackBackend,
      }, `Attempting fallback to ${getBackendDisplayName(fallbackBackend)}`);

      if (fallbackBackend === 'deepseek' && capabilityAdapter) {
        response = await capabilityAdapter.sendRequest(
          { ...anthropicRequest, stream: false },
          logContext,
        );
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

    const elapsedMs = Date.now() - requestStartedAt;
    logInfo('request_completed', {
      requestId: logContext.requestId,
      requestHash: logContext.requestHash,
      backend: selectedBackend,
      backendDisplayName: getBackendDisplayName(selectedBackend),
      stopReason: response.stop_reason,
      contentBlocks: response.content.length,
      elapsedMs,
    }, `Request completed via ${getBackendDisplayName(selectedBackend)}`);
    if (elapsedMs > NON_STREAM_SLOW_MS) {
      logWarn('slow_request', {
        requestId: logContext.requestId,
        requestHash: logContext.requestHash,
        backend: selectedBackend,
        model: anthropicRequest.model,
        messages: anthropicRequest.messages.length,
        tools: anthropicRequest.tools?.length || 0,
        elapsedMs,
        thresholdMs: NON_STREAM_SLOW_MS,
      });
    }

    if (anthropicRequest.stream) {
      return createStreamingResponse(response, logContext);
    }

    const jsonResponse = c.json(response);
    jsonResponse.headers.set('X-Request-ID', logContext.requestId);
    jsonResponse.headers.set('X-Request-Hash', logContext.requestHash);
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
    logError('messages_api_error', {
      requestId: logContext?.requestId || inboundRequestId || 'unknown',
      requestHash: logContext?.requestHash || 'unknown',
      elapsedMs: Date.now() - requestStartedAt,
      error: serializeError(error),
    }, 'Messages API error:');

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

    // AnthropicBackendError 来自 DeepSeek，SiderUpstreamError 来自 Sider 的 SSE 内业务错误码
    // （HTTP 200 + code != 0）。两者都已带好 statusCode，走到这里说明 fallback 用尽或不被允许。
    if (error instanceof AnthropicBackendError || error instanceof SiderUpstreamError) {
      const status = normalizeErrorStatus(error.statusCode);
      return c.json(
        {
          type: 'error',
          error: {
            type: mapErrorStatusToType(error.statusCode),
            message: error.message,
          },
        } satisfies AnthropicError,
        status,
      );
    }

    if (error instanceof Error) {
      return c.json(
        {
          type: 'error',
          error: {
            type: 'api_error',
            message: error.message,
          },
        } satisfies AnthropicError,
        500,
      );
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

function normalizeErrorStatus(statusCode: number): 400 | 401 | 403 | 404 | 429 | 500 | 502 | 503 {
  if (statusCode === 400) return 400;
  if (statusCode === 401) return 401;
  if (statusCode === 403) return 403;
  if (statusCode === 404) return 404;
  if (statusCode === 429) return 429;
  if (statusCode === 502) return 502;
  if (statusCode === 503) return 503;
  return 500;
}

/**
 * 按 Anthropic SSE 约定编码事件：每条事件同时带 `event:` 与 `data:` 行。
 * 只发 `data:` 时，依赖事件名分发的客户端会收不到任何内容。
 */
function encodeSSEEvent(encoder: TextEncoder, event: unknown): Uint8Array {
  const name = (event as { type?: string }).type;
  const data = `data: ${JSON.stringify(event)}\n\n`;
  return encoder.encode(name ? `event: ${name}\n${data}` : data);
}

function mapErrorStatusToType(statusCode: number): AnthropicError['error']['type'] {
  if (statusCode === 400) return 'invalid_request_error';
  if (statusCode === 401) return 'authentication_error';
  if (statusCode === 403) return 'permission_error';
  if (statusCode === 404) return 'not_found_error';
  if (statusCode === 429) return 'rate_limit_error';
  if (statusCode === 503) return 'overloaded_error';
  return 'api_error';
}

messagesRouter.post('/count_tokens', async (c: Context) => {
  try {
    const body = normalizeAnthropicRequest(await c.req.json() as AnthropicRequest);

    try {
      validateAnthropicRequest(body);
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
    consola.error('Token count error:', error);
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
    consola.error('Failed to get conversation stats:', error);
    return c.json({ error: 'Failed to get conversation stats' }, 500);
  }
});

messagesRouter.post('/conversations/cleanup', (c: Context) => {
  try {
    const cleaned = cleanupExpiredConversations(1);
    // 路由的会话后端记忆同属对话状态，一并回收，避免长期运行的实例只增不减。
    const cleanedRoutingSessions = routerEngine.cleanupExpiredSessions();
    return c.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      cleanedConversations: cleaned,
      cleanedRoutingSessions,
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

function createStreamingResponse(response: AnthropicResponse, logContext: RequestLogContext) {
  const encoder = new TextEncoder();
  const streamStartedAt = Date.now();

  const stream = new ReadableStream({
    start(controller) {
      let eventCount = 0;
      let firstEventLogged = false;
      let firstEventMs = 0;
      const send = (event: unknown) => {
        eventCount += 1;
        if (!firstEventLogged) {
          firstEventLogged = true;
          firstEventMs = Date.now() - streamStartedAt;
          logInfo('stream_first_event', {
            requestId: logContext.requestId,
            requestHash: logContext.requestHash,
            backend: 'buffered',
            model: response.model,
            elapsedMs: firstEventMs,
          });
          if (firstEventMs > STREAM_FIRST_EVENT_SLOW_MS) {
            logWarn('slow_stream_first_event', {
              requestId: logContext.requestId,
              requestHash: logContext.requestHash,
              backend: 'buffered',
              model: response.model,
              elapsedMs: firstEventMs,
              thresholdMs: STREAM_FIRST_EVENT_SLOW_MS,
            });
          }
        }
        controller.enqueue(encodeSSEEvent(encoder, event));
      };

      try {
        logInfo('stream_started', {
          requestId: logContext.requestId,
          requestHash: logContext.requestHash,
          backend: 'buffered',
          model: response.model,
        });

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
        const elapsedMs = Date.now() - streamStartedAt;
        logInfo('stream_completed', {
          requestId: logContext.requestId,
          requestHash: logContext.requestHash,
          backend: 'buffered',
          model: response.model,
          eventCount,
          firstEventMs,
          elapsedMs,
        });
        if (elapsedMs > STREAM_TOTAL_SLOW_MS) {
          logWarn('slow_stream_request', {
            requestId: logContext.requestId,
            requestHash: logContext.requestHash,
            backend: 'buffered',
            model: response.model,
            eventCount,
            elapsedMs,
            thresholdMs: STREAM_TOTAL_SLOW_MS,
          });
        }
        controller.close();
      } catch (error) {
        logWarn('stream_failed', {
          requestId: logContext.requestId,
          requestHash: logContext.requestHash,
          backend: 'buffered',
          model: response.model,
          eventCount,
          elapsedMs: Date.now() - streamStartedAt,
          error: serializeError(error),
        }, 'Streaming failed:');
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
      'X-Request-ID': logContext.requestId,
      'X-Request-Hash': logContext.requestHash,
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
