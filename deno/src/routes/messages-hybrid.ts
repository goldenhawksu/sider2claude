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
import type { AnthropicError, AnthropicRequest, AnthropicResponse } from '../types/anthropic.ts';
import type { SiderRequest } from '../types/sider.ts';
import {
  convertAnthropicToSider,
  convertAnthropicToSiderAsync,
  normalizeAnthropicRequest,
  validateAnthropicRequest,
} from '../utils/request-converter.ts';
import { siderClient } from '../utils/sider-client.ts';
import { convertSiderToAnthropic, getSessionHeaders } from '../utils/response-converter.ts';
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
import { AnthropicApiAdapter, AnthropicBackendError } from '../adapters/anthropic-adapter.ts';
import {
  createRequestLogContext,
  LARGE_REQUEST_BYTES,
  LARGE_REQUEST_MESSAGES,
  logError,
  logInfo,
  logWarn,
  NON_STREAM_SLOW_MS,
  observeDuplicateCandidate,
  type RequestLogContext,
  serializeError,
  STREAM_FIRST_EVENT_SLOW_MS,
  STREAM_TOTAL_SLOW_MS,
} from '../utils/request-observability.ts';

const messagesRouter = new Hono();

const config = loadBackendConfig();
const routerEngine = new RouterEngine(config);
const capabilityAdapter = config.deepseek.enabled ? new AnthropicApiAdapter(config.deepseek) : null;
const DUPLICATE_RESPONSE_CACHE_TTL_MS = 5 * 60_000;
const MAX_DUPLICATE_RESPONSE_CACHE_ENTRIES = 64;
const duplicateResponseCache = new Map<
  string,
  { response: AnthropicResponse; backend: Backend; storedAt: number }
>();

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

    warnLargeRequest(logContext, anthropicRequest);

    if (!anthropicRequest.stream) {
      const cached = getCachedDuplicateResponse(logContext.requestHash);
      if (cached) {
        logInfo('duplicate_request_replayed', {
          requestId: logContext.requestId,
          requestHash: logContext.requestHash,
          backend: cached.backend,
          ageMs: Date.now() - cached.storedAt,
          stopReason: cached.response.stop_reason,
          contentBlocks: cached.response.content.length,
        });

        const cachedResponse = c.json(cached.response);
        cachedResponse.headers.set('X-Request-ID', logContext.requestId);
        cachedResponse.headers.set('X-Request-Hash', logContext.requestHash);
        cachedResponse.headers.set('X-Duplicate-Replay', 'true');
        return cachedResponse;
      }
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

    // 流式请求走端到端真流式路径。SSE 一旦开始吐字无法换后端，故流式不做后端 fallback
    // （延迟优先，这是 SSE 代理的通行做法）；上游失败时在流内发 error 事件。
    if (anthropicRequest.stream) {
      return await handleStreamingRequest(
        anthropicRequest,
        auth.token,
        decision.backend,
        logContext,
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
    cacheDuplicateResponse(logContext.requestHash, selectedBackend, response);

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

    if (error instanceof AnthropicBackendError) {
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

function normalizeErrorStatus(statusCode: number): 400 | 401 | 403 | 404 | 429 | 500 | 503 {
  if (statusCode === 400) return 400;
  if (statusCode === 401) return 401;
  if (statusCode === 403) return 403;
  if (statusCode === 404) return 404;
  if (statusCode === 429) return 429;
  if (statusCode === 503) return 503;
  return 500;
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

function warnLargeRequest(
  logContext: RequestLogContext,
  request: AnthropicRequest,
): void {
  const requestBytes = logContext.summary.requestBytes;
  const messages = request.messages.length;
  if (requestBytes <= LARGE_REQUEST_BYTES && messages <= LARGE_REQUEST_MESSAGES) {
    return;
  }

  logWarn('large_request', {
    requestId: logContext.requestId,
    requestHash: logContext.requestHash,
    model: request.model,
    messages,
    tools: request.tools?.length || 0,
    requestBytes,
    requestBytesThreshold: LARGE_REQUEST_BYTES,
    messagesThreshold: LARGE_REQUEST_MESSAGES,
  });
}

function getCachedDuplicateResponse(
  requestHash: string,
): { response: AnthropicResponse; backend: Backend; storedAt: number } | undefined {
  cleanupDuplicateResponseCache();
  const cached = duplicateResponseCache.get(requestHash);
  if (!cached) {
    return undefined;
  }

  return {
    response: cloneAnthropicResponse(cached.response),
    backend: cached.backend,
    storedAt: cached.storedAt,
  };
}

function cacheDuplicateResponse(
  requestHash: string,
  backend: Backend,
  response: AnthropicResponse,
): void {
  cleanupDuplicateResponseCache();
  duplicateResponseCache.set(requestHash, {
    response: cloneAnthropicResponse(response),
    backend,
    storedAt: Date.now(),
  });

  while (duplicateResponseCache.size > MAX_DUPLICATE_RESPONSE_CACHE_ENTRIES) {
    const oldest = duplicateResponseCache.keys().next().value;
    if (!oldest) {
      return;
    }
    duplicateResponseCache.delete(oldest);
  }
}

function cleanupDuplicateResponseCache(now = Date.now()): void {
  for (const [hash, cached] of duplicateResponseCache.entries()) {
    if (now - cached.storedAt > DUPLICATE_RESPONSE_CACHE_TTL_MS) {
      duplicateResponseCache.delete(hash);
    }
  }
}

function cloneAnthropicResponse(response: AnthropicResponse): AnthropicResponse {
  return JSON.parse(JSON.stringify(response)) as AnthropicResponse;
}

/**
 * 流式请求分流：按路由决策选定后端，进入对应的真流式实现。
 */
async function handleStreamingRequest(
  anthropicRequest: AnthropicRequest,
  authToken: string,
  backend: Backend,
  logContext: RequestLogContext,
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
    if (anthropicRequest.tools?.length) {
      return createDeepSeekSynthesizedStreamingResponse(
        capabilityAdapter,
        anthropicRequest,
        logContext,
      );
    }
    return createDeepSeekStreamingResponse(capabilityAdapter, anthropicRequest, logContext);
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
    logContext,
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
  logContext: RequestLogContext,
): Response {
  const encoder = new TextEncoder();
  const streamStartedAt = Date.now();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
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
            backend: 'sider',
            model: outwardModel,
            elapsedMs: firstEventMs,
          });
          if (firstEventMs > STREAM_FIRST_EVENT_SLOW_MS) {
            logWarn('slow_stream_first_event', {
              requestId: logContext.requestId,
              requestHash: logContext.requestHash,
              backend: 'sider',
              model: outwardModel,
              elapsedMs: firstEventMs,
              thresholdMs: STREAM_FIRST_EVENT_SLOW_MS,
            });
          }
        }
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
        logInfo('stream_started', {
          requestId: logContext.requestId,
          requestHash: logContext.requestHash,
          backend: 'sider',
          model: outwardModel,
          includeThinking,
        });

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
        const elapsedMs = Date.now() - streamStartedAt;
        logInfo('stream_completed', {
          requestId: logContext.requestId,
          requestHash: logContext.requestHash,
          backend: 'sider',
          model: outwardModel,
          eventCount,
          firstEventMs,
          elapsedMs,
        });
        if (elapsedMs > STREAM_TOTAL_SLOW_MS) {
          logWarn('slow_stream_request', {
            requestId: logContext.requestId,
            requestHash: logContext.requestHash,
            backend: 'sider',
            model: outwardModel,
            eventCount,
            elapsedMs,
            thresholdMs: STREAM_TOTAL_SLOW_MS,
          });
        }
        safeClose();
      } catch (error) {
        logError('stream_error', {
          requestId: logContext.requestId,
          requestHash: logContext.requestHash,
          backend: 'sider',
          model: outwardModel,
          error: serializeError(error),
        }, 'Sider streaming failed:');
        ensureStart();
        closeBlock();
        send({
          type: 'error',
          error: {
            type: 'api_error',
            message: error instanceof Error ? error.message : 'Sider streaming error',
          },
        });
        logWarn('stream_failed', {
          requestId: logContext.requestId,
          requestHash: logContext.requestHash,
          backend: 'sider',
          model: outwardModel,
          eventCount,
          elapsedMs: Date.now() - streamStartedAt,
        }, 'Streaming failed:');
        safeClose();
      }
    },
  });

  return new Response(stream, {
    headers: {
      ...SSE_HEADERS,
      'X-Request-ID': logContext.requestId,
      'X-Request-Hash': logContext.requestHash,
    },
  });
}

/**
 * DeepSeek 工具流式：用非流式上游响应合成规范 Anthropic SSE，保证工具回合完整闭合。
 */
function createDeepSeekSynthesizedStreamingResponse(
  adapter: AnthropicApiAdapter,
  request: AnthropicRequest,
  logContext: RequestLogContext,
): Response {
  const encoder = new TextEncoder();
  const streamStartedAt = Date.now();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      let eventCount = 0;
      let firstEventLogged = false;
      let firstEventMs = 0;
      const send = (event: unknown) => {
        if (closed) {
          return;
        }
        eventCount += 1;
        if (!firstEventLogged) {
          firstEventLogged = true;
          firstEventMs = Date.now() - streamStartedAt;
          logInfo('stream_first_event', {
            requestId: logContext.requestId,
            requestHash: logContext.requestHash,
            backend: 'deepseek',
            model: request.model,
            mode: 'synthesized',
            elapsedMs: firstEventMs,
          });
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      const safeClose = () => {
        if (!closed) {
          closed = true;
          controller.close();
        }
      };
      const keepAlive = setInterval(() => send({ type: 'ping' }), 10_000);

      try {
        logInfo('stream_started', {
          requestId: logContext.requestId,
          requestHash: logContext.requestHash,
          backend: 'deepseek',
          model: request.model,
          tools: request.tools?.length || 0,
          mode: 'synthesized',
        });

        send({
          type: 'message_start',
          message: {
            id: generateStreamMessageId(),
            type: 'message',
            role: 'assistant',
            content: [],
            model: request.model,
            stop_reason: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        });

        const response = await adapter.sendRequest({ ...request, stream: false }, logContext);
        cacheDuplicateResponse(logContext.requestHash, 'deepseek', response);
        sendAnthropicResponseContentAsStream(response, send);
        send({
          type: 'message_delta',
          delta: { stop_reason: response.stop_reason },
          usage: { output_tokens: response.usage.output_tokens },
        });
        send({ type: 'message_stop' });

        const elapsedMs = Date.now() - streamStartedAt;
        logInfo('stream_completed', {
          requestId: logContext.requestId,
          requestHash: logContext.requestHash,
          backend: 'deepseek',
          model: request.model,
          mode: 'synthesized',
          stopReason: response.stop_reason,
          eventCount,
          firstEventMs,
          elapsedMs,
        });
        if (elapsedMs > STREAM_TOTAL_SLOW_MS) {
          logWarn('slow_stream_request', {
            requestId: logContext.requestId,
            requestHash: logContext.requestHash,
            backend: 'deepseek',
            model: request.model,
            mode: 'synthesized',
            eventCount,
            elapsedMs,
            thresholdMs: STREAM_TOTAL_SLOW_MS,
          });
        }
        safeClose();
      } catch (error) {
        send({
          type: 'error',
          error: {
            type: 'api_error',
            message: error instanceof Error ? error.message : 'DeepSeek streaming error',
          },
        });
        logWarn('stream_failed', {
          requestId: logContext.requestId,
          requestHash: logContext.requestHash,
          backend: 'deepseek',
          model: request.model,
          mode: 'synthesized',
          eventCount,
          elapsedMs: Date.now() - streamStartedAt,
          error: serializeError(error),
        }, 'Streaming failed:');
        safeClose();
      } finally {
        clearInterval(keepAlive);
      }
    },
  });

  return new Response(stream, {
    headers: {
      ...SSE_HEADERS,
      'X-Request-ID': logContext.requestId,
      'X-Request-Hash': logContext.requestHash,
    },
  });
}

function sendAnthropicResponseContentAsStream(
  response: AnthropicResponse,
  send: (event: unknown) => void,
): void {
  response.content.forEach((block, index) => {
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
        content_block: { type: 'thinking', thinking: '' },
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
        partial_json: JSON.stringify(block.input ?? {}),
      },
    });
    send({ type: 'content_block_stop', index });
  });
}

/**
 * DeepSeek 普通流式：DeepSeek 的 /v1/messages 原生输出 Anthropic SSE，直接透传上游事件。
 */
function createDeepSeekStreamingResponse(
  adapter: AnthropicApiAdapter,
  request: AnthropicRequest,
  logContext: RequestLogContext,
): Response {
  const encoder = new TextEncoder();
  const streamStartedAt = Date.now();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
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
            backend: 'deepseek',
            model: request.model,
            elapsedMs: firstEventMs,
          });
          if (firstEventMs > STREAM_FIRST_EVENT_SLOW_MS) {
            logWarn('slow_stream_first_event', {
              requestId: logContext.requestId,
              requestHash: logContext.requestHash,
              backend: 'deepseek',
              model: request.model,
              elapsedMs: firstEventMs,
              thresholdMs: STREAM_FIRST_EVENT_SLOW_MS,
            });
          }
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      const safeClose = () => {
        if (!closed) {
          closed = true;
          controller.close();
        }
      };

      try {
        logInfo('stream_started', {
          requestId: logContext.requestId,
          requestHash: logContext.requestHash,
          backend: 'deepseek',
          model: request.model,
          tools: request.tools?.length || 0,
        });

        await adapter.sendStreamRequest(
          request,
          (chunk) => send(chunk),
          () => {
            const elapsedMs = Date.now() - streamStartedAt;
            logInfo('stream_completed', {
              requestId: logContext.requestId,
              requestHash: logContext.requestHash,
              backend: 'deepseek',
              model: request.model,
              eventCount,
              firstEventMs,
              elapsedMs,
            });
            if (elapsedMs > STREAM_TOTAL_SLOW_MS) {
              logWarn('slow_stream_request', {
                requestId: logContext.requestId,
                requestHash: logContext.requestHash,
                backend: 'deepseek',
                model: request.model,
                eventCount,
                elapsedMs,
                thresholdMs: STREAM_TOTAL_SLOW_MS,
              });
            }
            safeClose();
          },
          (error) => {
            send({
              type: 'error',
              error: {
                type: 'api_error',
                message: error.message,
              },
            });
            logWarn('stream_failed', {
              requestId: logContext.requestId,
              requestHash: logContext.requestHash,
              backend: 'deepseek',
              model: request.model,
              eventCount,
              elapsedMs: Date.now() - streamStartedAt,
            }, 'Streaming failed:');
            safeClose();
          },
          logContext,
        );
      } catch (error) {
        send({
          type: 'error',
          error: {
            type: 'api_error',
            message: error instanceof Error ? error.message : 'DeepSeek streaming error',
          },
        });
        logWarn('stream_failed', {
          requestId: logContext.requestId,
          requestHash: logContext.requestHash,
          backend: 'deepseek',
          model: request.model,
          eventCount,
          elapsedMs: Date.now() - streamStartedAt,
          error: serializeError(error),
        }, 'Streaming failed:');
        safeClose();
      }
    },
  });

  return new Response(stream, {
    headers: {
      ...SSE_HEADERS,
      'X-Request-ID': logContext.requestId,
      'X-Request-Hash': logContext.requestHash,
    },
  });
}

export { messagesRouter as hybridMessagesRouter };
