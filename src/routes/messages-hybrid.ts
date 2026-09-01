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
import { recordSiderQuotaExhausted, resolveSiderCooldownMs } from '../utils/sider-availability';
import {
  recordSiderOversize,
  recordSiderQuotaExhausted as recordThrottleQuota,
  recordSiderConcurrencyLimit,
  recordSiderRejection,
  recordSiderSuccess,
} from '../utils/sider-throttle';
import { classifyDeepSeekReason, recordUsage } from '../utils/usage-stats';
import { buildToolContract } from '../utils/textual-tool-use';
import { persistSiderTelemetry } from '../utils/sider-telemetry';
import { convertSiderToAnthropic, getSessionHeaders } from '../utils/response-converter';
import { cleanupExpiredConversations, getConversationStats } from '../utils/conversation-manager';
import { cleanupExpiredSiderSessions, getSiderSessionStats } from '../utils/sider-session-manager';
import {
  type Backend,
  getBackendDisplayName,
  loadBackendConfig,
  usesAdaptiveThrottle,
  siderHandlesTools,
} from '../config/backends';
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
        .filter((block: any) => block.type === 'tool_use')
        .map((block: any) => block.name),
      // Node 侧流式是 buffered 模式：先完成本流程再转 SSE，因此此处
      // 用请求自身的 stream 标志，流式请求不会被误记为非流式。
      stream: !!anthropicRequest.stream,
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
        retryAfterHeaders(error, status),
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
  // 上游在 1135 的消息里写了恢复时长就带上，两条冷却通道都优先按它退避。
  const retryAfterMs = error instanceof SiderUpstreamError ? error.retryAfterMs : undefined;

  if (!error) {
    if (adaptive) {
      recordSiderSuccess(model, payloadChars);
    }
  } else if (siderCode === 1135) {
    if (adaptive) {
      recordThrottleQuota(model, undefined, retryAfterMs);
    } else {
      recordSiderQuotaExhausted(model, undefined, retryAfterMs);
    }
    logWarn('sider_quota_cooldown', {
      requestId: logContext.requestId,
      model,
      strategy: config.routing.siderStrategy,
      cooldownMs: adaptive ? undefined : resolveSiderCooldownMs(model, retryAfterMs),
      upstreamRetryAfterMs: retryAfterMs,
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

  // Node 侧无 KV，遥测是 no-op；保留调用以保持双侧结构对称。
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

function normalizeErrorStatus(
  statusCode: number,
): 400 | 401 | 403 | 404 | 413 | 429 | 500 | 502 | 503 {
  if (statusCode === 400) return 400;
  if (statusCode === 401) return 401;
  if (statusCode === 403) return 403;
  if (statusCode === 404) return 404;
  if (statusCode === 413) return 413;
  if (statusCode === 429) return 429;
  if (statusCode === 502) return 502;
  if (statusCode === 503) return 503;
  return 500;
}

/**
 * 所有 429 都要带 `Retry-After`，**包括上游透传的那些**。
 *
 * Anthropic / OpenAI 官方 SDK 都靠这个头做退避重试；缺了它，SDK 会退化成固定间隔
 * 盲重试，反而加重本就额度稀缺的上游。
 *
 * 取值优先用上游自己写的时长（1135 的消息里有），没有才用保守默认值。向上取整到
 * 整秒：宁可让客户端多等一秒，也不要早于上游给的时刻去重试。
 *
 * 只覆盖非流式路径。流式一旦开始，HTTP 头早已发出，那时的失败只能在 SSE body 里
 * 用 `error` 事件表达——这是协议决定的，不是这里漏了。
 */
const DEFAULT_RETRY_AFTER_MS = 60_000;

function retryAfterHeaders(error: unknown, status: number): Record<string, string> | undefined {
  if (status !== 429) {
    return undefined;
  }
  const hinted = error instanceof SiderUpstreamError ? error.retryAfterMs : undefined;
  const seconds = Math.max(1, Math.ceil((hinted ?? DEFAULT_RETRY_AFTER_MS) / 1000));
  return { 'Retry-After': String(seconds) };
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
  if (statusCode === 413) return 'request_too_large';
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

  // 反馈埋在这里而不是外层 catch：只有这一层同时握有「实际投出的载荷长度」
  // 与「上游返回的错误码」，而自适应体量学习两者缺一不可。
  // Max 策略：Sider 的 `tools` 字段只认它自己的原生工具（search/web_browse/…），
  // Anthropic 工具定义会被 buildSafeToolsConfig 直接丢弃。所以工具能力只能靠
  // 把契约拼进正文——这也正是 probe 验证时的做法。
  if (siderToolContractEnabled(anthropicRequest)) {
    const block = siderRequest.multi_content?.[0];
    if (block) {
      block.text = `${block.text}

${buildToolContract(anthropicRequest.tools)}`;
    }
  }

  const payloadChars = siderRequest.multi_content?.[0]?.text?.length ?? 0;
  const startedAt = Date.now();
  const hasTools = siderToolContractEnabled(anthropicRequest);

  try {
    const siderResponse = await siderClient.chat(siderRequest, siderAuthToken);
    const response = convertSiderToAnthropic(siderResponse, anthropicRequest.model, {
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
