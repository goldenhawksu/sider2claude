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
import { SiderUpstreamError, siderUpstreamError } from '../utils/sse-line-reader.ts';
import { recordSiderQuotaExhausted, siderCooldownMsFor } from '../utils/sider-availability.ts';
import {
  recordSiderOversize,
  recordSiderQuotaExhausted as recordThrottleQuota,
  recordSiderConcurrencyLimit,
  recordSiderRejection,
  recordSiderSuccess,
} from '../utils/sider-throttle.ts';
import { classifyDeepSeekReason, recordCachedReplay, recordUsage } from '../utils/usage-stats.ts';
import { buildToolContract } from '../utils/textual-tool-use.ts';
import { persistSiderTelemetry } from '../utils/sider-telemetry.ts';
import type { DeepSeekReason } from '../utils/usage-stats.ts';
import {
  convertSiderToAnthropic,
  getSessionHeaders,
  SiderToolRestoreError,
} from '../utils/response-converter.ts';
import {
  cleanupExpiredConversations,
  getConversationStats,
} from '../utils/conversation-manager.ts';
import {
  cleanupExpiredSiderSessions,
  getSiderSessionStats,
} from '../utils/sider-session-manager.ts';
import {
  type Backend,
  getBackendDisplayName,
  loadBackendConfig,
  siderHandlesTools,
  usesAdaptiveThrottle,
} from '../config/backends.ts';
import { RouterEngine } from '../routing/router-engine.ts';
import type { RoutingDecision } from '../routing/router-engine.ts';
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
        recordCachedReplay();

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
        decision,
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
        response = await callSider(
          anthropicRequest,
          auth.token,
          logContext,
          conversationId,
          parentMessageId,
        );

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
        response = await callSider(
          anthropicRequest,
          auth.token,
          logContext,
          conversationId,
          parentMessageId,
        );
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
    recordUsage({
      model: anthropicRequest.model,
      backend: selectedBackend,
      // 实际后端与路由初判不同 = 中途发生过 fallback。
      fallback: selectedBackend !== decision.backend,
      deepseekReason: classifyDeepSeekReason(selectedBackend, decision.backend, decision.ruleId),
      toolUses: response.content
        .filter((block) => block.type === 'tool_use')
        .map((block) => block.name),
      stream: false,
      ms: elapsedMs,
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      cacheReadTokens: response.usage?.cache_read_input_tokens,
      cacheCreationTokens: response.usage?.cache_creation_input_tokens,
    });
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
        error.message.includes('At least one user message is required') ||
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

/**
 * 把一次 Sider 调用的结果喂回限流层。
 *
 * `conservative` 只记熔断，且只认 1135：其余错误码是上游故障或请求问题，
 * 不代表额度耗尽，熔断它们会把偶发抖动放大成长时间不可用。
 *
 * `pro` / `max` 下三种信号各驱动一个维度：
 * - 成功 -> 上探频次与体量上限；
 * - 1135 -> 乘性降速，连续多次才升级为熔断；
 * - 603  -> 把体量上限直接降到失败载荷以下。
 *
 * 603 在保守策略下没有反馈渠道——那时体量上限是写死的静态值，撞了也学不到东西。
 */
function noteSiderOutcome(
  model: string,
  payloadChars: number,
  error: unknown,
  logContext: RequestLogContext,
  elapsedMs = 0,
  hasTools = false,
  restoredToolUse = false,
): void {
  const adaptive = usesAdaptiveThrottle(config.routing.siderStrategy);
  const siderCode = error instanceof SiderUpstreamError ? error.siderCode : 0;

  if (!error) {
    if (adaptive) {
      recordSiderSuccess(model, payloadChars);
    }
  } else if (siderCode === 1135) {
    if (adaptive) {
      recordThrottleQuota(model);
    } else {
      recordSiderQuotaExhausted(model);
    }
    logWarn('sider_quota_cooldown', {
      requestId: logContext.requestId,
      model,
      strategy: config.routing.siderStrategy,
      cooldownMs: adaptive ? undefined : siderCooldownMsFor(model),
    }, `Sider quota exhausted for ${model}`);
  } else if (siderCode === 603 && adaptive) {
    recordSiderOversize(model, payloadChars);
    logWarn('sider_oversize_learned', {
      requestId: logContext.requestId,
      model,
      payloadChars,
    }, `Sider rejected ${payloadChars} chars; lowering the learned size limit for ${model}`);
  } else if (siderCode === 1101 && adaptive) {
    // 并发限流：Sider 同一时刻只接一个 active request。实测一簇并发会在几毫秒内
    // 产生多次连续 1101，**绝不能走停投通道**——那样一次 10 并发就会把一个完全
    // 健康的模型停投 5 分钟。只降速，让后续能挤进来的请求变少。
    recordSiderConcurrencyLimit(model);
    logWarn('sider_concurrency_limited', {
      requestId: logContext.requestId,
      model,
    }, `Sider is busy with another request for ${model}; slowing down`);
  } else if (siderCode !== 0 && adaptive) {
    // 其余**明确的业务错误码**（如 707「该模型不可用」）：既不是时机问题也不是
    // 载荷问题，速率与体量上限调多少都没用。交给持久性拒绝通道——连续 3 次才
    // 暂停投递，且到期用 half-open 探测自己摸恢复。
    //
    // 只认 siderCode ≠ 0：网络抖动/超时拿不到业务码，那才是「偶发上游故障」，
    // 学它会把一次抖动放大成 5 分钟不可用。
    recordSiderRejection(model, siderCode);
    logWarn('sider_upstream_rejected', {
      requestId: logContext.requestId,
      model,
      siderCode,
    }, `Sider rejected ${model} with code ${siderCode}`);
  }

  // 运行遥测：每轮 Sider 调用记一条白名单字段，供离线分析优化调度。
  persistSiderTelemetry({
    ts: Date.now(),
    model,
    strategy: config.routing.siderStrategy,
    payloadChars,
    ok: !error,
    siderCode,
    ms: elapsedMs,
    hasTools,
    restoredToolUse,
  });
}

/** 本次实际投给 Sider 的载荷字符数 —— 自适应体量学习的输入。 */
function siderPayloadChars(request: SiderRequest): number {
  return request.multi_content?.[0]?.text?.length ?? 0;
}

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
    // 路由的会话后端记忆同属对话状态，一并回收，避免长期运行的实例只增不减。
    const cleanedRoutingSessions = routerEngine.cleanupExpiredSessions();
    return c.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      cleanedConversations: cleaned,
      cleanedRoutingSessions,
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

  // Max 策略：Sider 的 `tools` 字段只认它自己的原生工具（search/web_browse/…），
  // Anthropic 工具定义会被 buildSafeToolsConfig 直接丢弃。所以工具能力只能靠
  // 把契约拼进正文——这也正是 probe 验证时的做法。
  if (siderToolContractEnabled(anthropicRequest)) {
    const block = siderRequest.multi_content?.[0];
    if (block) {
      block.text = `${block.text}\n\n${buildToolContract(anthropicRequest.tools)}`;
    }
  }

  return { siderRequest, siderAuthToken };
}

/** Max 策略 + 请求确实带了工具时，才给 Sider 注入工具契约。 */
function siderToolContractEnabled(request: AnthropicRequest): boolean {
  return siderHandlesTools(config.routing.siderStrategy) && !!request.tools?.length;
}

async function callSider(
  anthropicRequest: AnthropicRequest,
  authToken: string,
  logContext: RequestLogContext,
  conversationId?: string,
  parentMessageId?: string,
): Promise<AnthropicResponse> {
  const { siderRequest, siderAuthToken } = await buildSiderRequest(
    anthropicRequest,
    authToken,
    conversationId,
    parentMessageId,
  );

  // 反馈埋在这里而不是外层 catch：只有这一层同时握有「实际投出的载荷长度」
  // 与「上游返回的错误码」，而自适应体量学习两者缺一不可。
  const payloadChars = siderPayloadChars(siderRequest);
  const startedAt = Date.now();
  const hasTools = siderToolContractEnabled(anthropicRequest);

  try {
    const siderResponse = await siderClient.chat(siderRequest, siderAuthToken);
    const response = convertSiderToAnthropic(siderResponse, anthropicRequest.model, {
      includeThinking: isThinkingEnabled(anthropicRequest),
      // 带上原始请求 = 开启文本工具调用还原（需要 tools 的 input_schema 做 schema
      // 制导修复，以及历史 tool_use id 来识别模型在复述而非发起新调用）。
      ...(hasTools ? { restoreToolUse: anthropicRequest } : {}),
    });
    noteSiderOutcome(
      anthropicRequest.model,
      payloadChars,
      undefined,
      logContext,
      Date.now() - startedAt,
      hasTools,
      response.content.some((b) => b.type === 'tool_use'),
    );
    return response;
  } catch (error) {
    noteSiderOutcome(
      anthropicRequest.model,
      payloadChars,
      error,
      logContext,
      Date.now() - startedAt,
      hasTools,
    );
    throw error;
  }
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
 * 按 Anthropic SSE 约定编码事件：每条事件同时带 `event:` 与 `data:` 行。
 * 只发 `data:` 时，依赖事件名分发的客户端会收不到任何内容。
 */
function encodeSSEEvent(encoder: TextEncoder, event: unknown): Uint8Array {
  const name = (event as { type?: string }).type;
  const data = `data: ${JSON.stringify(event)}\n\n`;
  return encoder.encode(name ? `event: ${name}\n${data}` : data);
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
  // 缓存键带流式标记：指纹刻意忽略 stream 以跨流式/非流式识别客户端重试（观测用），
  // 但响应缓存不能共享——非流式回放流式缓存的响应属于语义错配。
  const cached = duplicateResponseCache.get(`${requestHash}:non-stream`);
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
  duplicateResponseCache.set(`${requestHash}:non-stream`, {
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
  decision: RoutingDecision,
  logContext: RequestLogContext,
  conversationId?: string,
  parentMessageId?: string,
): Promise<Response> {
  const backend = decision.backend;
  // 流式设计上不做后端 fallback，所以实际后端恒等于路由初判：
  // 归因只可能是 tools / routing，不会出现 fallback。
  const deepseekReason = classifyDeepSeekReason(backend, backend, decision.ruleId);

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
        deepseekReason,
      );
    }
    return createDeepSeekStreamingResponse(
      capabilityAdapter,
      anthropicRequest,
      logContext,
      deepseekReason,
    );
  }

  if (conversationId) {
    routerEngine.recordSessionBackend(conversationId, 'sider');
  }

  // Max 策略下的工具请求必须走合成流：Sider 是把工具调用当**正文文本**吐出来的
  // （`[tool_use:X] id=Y input={...}`），真流式逐 delta 直发会把这一行当普通回答
  // 推给客户端，等到发现要还原时字已经吐出去了。先非流式收完、还原成 tool_use
  // 再合成 SSE，顺带让「还原失败」和「上游报错」都能在吐字之前拦下来转投 DeepSeek。
  if (siderToolContractEnabled(anthropicRequest)) {
    return createSiderSynthesizedStreamingResponse(
      anthropicRequest,
      authToken,
      logContext,
      conversationId,
      parentMessageId,
    );
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
    anthropicRequest,
    logContext,
  );
}

/**
 * Sider 合成流（Max 策略的工具请求专用）。
 *
 * 与真流式的区别只有一个，但很关键：**先把响应收完再开始吐**。Sider 靠文本契约
 * 表达工具调用，那一行只有在整段文本到手后才能还原成 `tool_use`；边收边吐就来不及了。
 *
 * 收完再吐还换来一个好处：这一刻还没向客户端发过任何内容块，因此「上游报错」与
 * 「调用还原失败」都能干净地转投 DeepSeek，不必依赖真流式那个「还没吐字符」的
 * 脆弱窗口。代价是首字延迟等于整个 Sider 响应时长——工具回合本来就要等结果，
 * 这个代价可以接受。
 */
function createSiderSynthesizedStreamingResponse(
  anthropicRequest: AnthropicRequest,
  authToken: string,
  logContext: RequestLogContext,
  conversationId?: string,
  parentMessageId?: string,
): Response {
  const encoder = new TextEncoder();
  const streamStartedAt = Date.now();
  const outwardModel = anthropicRequest.model;

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event: unknown) => {
        if (closed) return;
        controller.enqueue(encodeSSEEvent(encoder, event));
      };
      const safeClose = () => {
        if (!closed) {
          closed = true;
          controller.close();
        }
      };

      send({
        type: 'message_start',
        message: {
          id: generateStreamMessageId(),
          type: 'message',
          role: 'assistant',
          content: [],
          model: outwardModel,
          stop_reason: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });

      let backend: Backend = 'sider';
      let response: AnthropicResponse;
      try {
        response = await callSider(
          anthropicRequest,
          authToken,
          logContext,
          conversationId,
          parentMessageId,
        );
      } catch (error) {
        logWarn('sider_tool_turn_failed', {
          requestId: logContext.requestId,
          requestHash: logContext.requestHash,
          model: outwardModel,
          restoreFailure: error instanceof SiderToolRestoreError,
          error: serializeError(error),
        }, 'Sider could not serve this tool turn; falling back to DeepSeek');

        if (!capabilityAdapter) {
          send({
            type: 'error',
            error: {
              type: error instanceof SiderUpstreamError
                ? mapErrorStatusToType(error.statusCode)
                : 'api_error',
              message: error instanceof Error ? error.message : 'Sider tool turn failed',
            },
          });
          safeClose();
          return;
        }

        try {
          response = await capabilityAdapter.sendRequest(
            { ...anthropicRequest, stream: false },
            logContext,
          );
          backend = 'deepseek';
          if (conversationId) {
            routerEngine.recordSessionBackend(conversationId, 'deepseek');
          }
        } catch (fallbackError) {
          logError('stream_fallback_failed', {
            requestId: logContext.requestId,
            requestHash: logContext.requestHash,
            model: outwardModel,
            error: serializeError(fallbackError),
          }, 'DeepSeek fallback for Sider tool turn failed:');
          send({
            type: 'error',
            error: { type: 'api_error', message: 'Both backends failed for this tool turn' },
          });
          safeClose();
          return;
        }
      }

      sendAnthropicResponseContentAsStream(response, send);
      send({
        type: 'message_delta',
        delta: { stop_reason: response.stop_reason },
        usage: { output_tokens: response.usage?.output_tokens ?? 0 },
      });
      send({ type: 'message_stop' });

      const elapsedMs = Date.now() - streamStartedAt;
      const toolUses = response.content
        .filter((block) => block.type === 'tool_use')
        .map((block) => block.name);
      logInfo('stream_completed', {
        requestId: logContext.requestId,
        requestHash: logContext.requestHash,
        backend,
        model: outwardModel,
        mode: 'sider_synthesized',
        stopReason: response.stop_reason,
        toolUses: toolUses.length,
        elapsedMs,
      });
      recordUsage({
        model: outwardModel,
        backend,
        fallback: backend !== 'sider',
        deepseekReason: backend === 'deepseek' ? 'fallback' : undefined,
        toolUses,
        stream: true,
        ms: elapsedMs,
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
        cacheReadTokens: response.usage?.cache_read_input_tokens,
        cacheCreationTokens: response.usage?.cache_creation_input_tokens,
      });
      safeClose();
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
 * Sider 真流式：用 content block 状态机把 Sider SSE 事件实时映射为 Anthropic SSE。
 * reasoning_content -> thinking 块（仅在请求开启 thinking 时）；text -> text 块。
 *
 * Sider 失败时会尝试**无感**切到 DeepSeek，见下方 catch 块的说明。
 */
function createTrueSiderStreamingResponse(
  siderRequest: SiderRequest,
  siderAuthToken: string,
  anthropicRequest: AnthropicRequest,
  logContext: RequestLogContext,
): Response {
  const outwardModel = anthropicRequest.model;
  const includeThinking = isThinkingEnabled(anthropicRequest);
  const payloadChars = siderPayloadChars(siderRequest);
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
        controller.enqueue(encodeSSEEvent(encoder, event));
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

      let keepAlive: ReturnType<typeof setInterval> | undefined;
      try {
        logInfo('stream_started', {
          requestId: logContext.requestId,
          requestHash: logContext.requestHash,
          backend: 'sider',
          model: outwardModel,
          includeThinking,
        });

        ensureStart();
        keepAlive = setInterval(() => send({ type: 'ping' }), 10_000);

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
          onWarning(code, msg) {
            // Sider 在 SSE 内用 code 表达业务失败（HTTP 仍是 200）。抛出让下面的 catch
            // 统一收尾成 error 事件，否则客户端只会收到一个没有内容块的空流。
            throw siderUpstreamError(code, msg);
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
        noteSiderOutcome(outwardModel, payloadChars, undefined, logContext, elapsedMs);
        logInfo('stream_completed', {
          requestId: logContext.requestId,
          requestHash: logContext.requestHash,
          backend: 'sider',
          model: outwardModel,
          eventCount,
          firstEventMs,
          elapsedMs,
        });
        recordUsage({
          model: outwardModel,
          backend: 'sider',
          fallback: false, // 流式设计上不做后端 fallback
          toolUses: [], // Sider 不承接工具请求（路由保证），流内不会出现 tool_use
          stream: true,
          ms: elapsedMs,
          // Sider 真流式不回传 token 用量，计 0；总量以非流式请求为准
          inputTokens: 0,
          outputTokens: 0,
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
        noteSiderOutcome(
          outwardModel,
          payloadChars,
          error,
          logContext,
          Date.now() - streamStartedAt,
        );

        // 无感切到 DeepSeek。
        //
        // 窗口条件是「一个内容块都还没开过」：此时客户端只收到过 message_start，
        // 而那个事件不带任何后端烙印（id 本地生成、model 是客户端请求的模型名），
        // 所以改由 DeepSeek 续吐，客户端在协议上无法区分。一旦已经吐过内容就没有
        // 回退空间了——那时切换会让文本断裂或重复，只能老实报错。
        //
        // 这条兜底是激进投递策略的前置安全网：主动碰撞 Sider 的额度上限意味着
        // 失败会变多，没有它，用户就会直接看到失败。
        if (
          currentBlock === null && blockIndex === -1 && capabilityAdapter &&
          config.routing.autoFallback
        ) {
          try {
            const response = await capabilityAdapter.sendRequest(
              { ...anthropicRequest, stream: false },
              logContext,
            );
            sendAnthropicResponseContentAsStream(response, send);
            send({
              type: 'message_delta',
              delta: { stop_reason: response.stop_reason },
              usage: { output_tokens: response.usage?.output_tokens ?? 0 },
            });
            send({ type: 'message_stop' });

            const fallbackMs = Date.now() - streamStartedAt;
            logWarn('stream_fallback_succeeded', {
              requestId: logContext.requestId,
              requestHash: logContext.requestHash,
              fromBackend: 'sider',
              toBackend: 'deepseek',
              model: outwardModel,
              elapsedMs: fallbackMs,
            }, 'Sider stream failed before any content; served by DeepSeek instead');
            recordUsage({
              model: outwardModel,
              backend: 'deepseek',
              fallback: true,
              deepseekReason: 'fallback',
              toolUses: response.content
                .filter((block) => block.type === 'tool_use')
                .map((block) => block.name),
              stream: true,
              ms: fallbackMs,
              inputTokens: response.usage?.input_tokens ?? 0,
              outputTokens: response.usage?.output_tokens ?? 0,
              cacheReadTokens: response.usage?.cache_read_input_tokens,
              cacheCreationTokens: response.usage?.cache_creation_input_tokens,
            });
            safeClose();
            return;
          } catch (fallbackError) {
            logError('stream_fallback_failed', {
              requestId: logContext.requestId,
              requestHash: logContext.requestHash,
              model: outwardModel,
              error: serializeError(fallbackError),
            }, 'DeepSeek fallback for Sider stream failed:');
            // 落到下面的 error 事件，把原始的 Sider 错误告诉客户端
          }
        }

        ensureStart();
        closeBlock();
        send({
          type: 'error',
          error: {
            type: error instanceof SiderUpstreamError
              ? mapErrorStatusToType(error.statusCode)
              : 'api_error',
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
      } finally {
        if (keepAlive) {
          clearInterval(keepAlive);
        }
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
  deepseekReason?: DeepSeekReason,
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
        controller.enqueue(encodeSSEEvent(encoder, event));
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
        // 不写入重复响应缓存：本路径响应以流式事件下发，缓存它只会让后续的
        // 非流式请求回放一份来源语义不同的快照（幂等重试缓存只覆盖非流式）。
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
        recordUsage({
          model: request.model,
          backend: 'deepseek',
          fallback: false, // 流式设计上不做后端 fallback
          deepseekReason,
          toolUses: response.content
            .filter((block) => block.type === 'tool_use')
            .map((block) => block.name),
          stream: true,
          ms: elapsedMs,
          inputTokens: response.usage?.input_tokens ?? 0,
          outputTokens: response.usage?.output_tokens ?? 0,
          cacheReadTokens: response.usage?.cache_read_input_tokens,
          cacheCreationTokens: response.usage?.cache_creation_input_tokens,
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
  deepseekReason?: DeepSeekReason,
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
        controller.enqueue(encodeSSEEvent(encoder, event));
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

        // 透传上游 token 用量：真流式没有汇总响应，只能从事件里捡。
        // input_tokens 与缓存计数都在 message_start，output_tokens 在 message_delta。
        let inputTokens = 0;
        let outputTokens = 0;
        let cacheReadTokens: number | undefined;
        let cacheCreationTokens: number | undefined;
        const collectUsage = (chunk: unknown) => {
          const event = chunk as {
            type?: string;
            message?: {
              usage?: {
                input_tokens?: number;
                cache_read_input_tokens?: number;
                cache_creation_input_tokens?: number;
              };
            };
            usage?: { output_tokens?: number };
          };
          if (event?.type === 'message_start') {
            const usage = event.message?.usage;
            inputTokens = usage?.input_tokens ?? inputTokens;
            cacheReadTokens = usage?.cache_read_input_tokens ?? cacheReadTokens;
            cacheCreationTokens = usage?.cache_creation_input_tokens ?? cacheCreationTokens;
          } else if (event?.type === 'message_delta') {
            outputTokens = event.usage?.output_tokens ?? outputTokens;
          }
        };

        await adapter.sendStreamRequest(
          request,
          (chunk) => {
            collectUsage(chunk);
            send(chunk);
          },
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
            // 这条路径过去没有埋点，DeepSeek 的无工具流式请求在统计里凭空消失，
            // 后端占比与模型归因都会偏向 Sider。
            recordUsage({
              model: request.model,
              backend: 'deepseek',
              fallback: false, // 流式设计上不做后端 fallback
              deepseekReason,
              toolUses: [], // 本路径仅在请求不带 tools 时进入
              stream: true,
              ms: elapsedMs,
              inputTokens,
              outputTokens,
              cacheReadTokens,
              cacheCreationTokens,
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
