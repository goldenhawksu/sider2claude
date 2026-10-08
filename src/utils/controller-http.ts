import type { AnthropicRequest } from '../types/anthropic.js';
import { ControllerError, runSiderController } from './sider-controller.js';
import { SiderUpstreamError } from './sider-client.js';
import { logInfo, logWarn, type RequestLogContext } from './request-observability.js';

function errorBody(error: unknown) {
  const status = error instanceof ControllerError || error instanceof SiderUpstreamError
    ? error.statusCode
    : 502;
  const type = status === 429
    ? 'rate_limit_error'
    : status === 413
    ? 'request_too_large'
    : status === 400 || status === 409
    ? 'invalid_request_error'
    : 'api_error';
  return {
    status,
    body: {
      type: 'error',
      error: { type, message: error instanceof Error ? error.message : '主控请求失败' },
    },
  };
}
export async function controllerResponse(
  request: AnthropicRequest,
  token: string,
  context: RequestLogContext,
  signal?: AbortSignal,
  session?: string,
): Promise<Response> {
  const headers = {
    'X-Request-ID': context.requestId,
    'X-Request-Hash': context.requestHash,
    'X-Backend-Used': 'sider',
    'X-Sider-Controller': 'true',
  };
  if (!request.stream) {
    try {
      const response = await runSiderController(request, token, signal, session);
      return Response.json(response, {
        headers: { ...headers, 'X-Conversation-ID': response.sider_session!.conversation_id },
      });
    } catch (error) {
      const { status, body } = errorBody(error);
      logWarn('controller_failed', {
        requestId: context.requestId,
        status,
        message: body.error.message,
      });
      const retry = error instanceof ControllerError || error instanceof SiderUpstreamError
        ? error.retryAfterMs
        : undefined;
      return Response.json(body, {
        status,
        headers: {
          ...headers,
          ...(status === 429 ? { 'Retry-After': String(Math.ceil((retry ?? 1000) / 1000)) } : {}),
        },
      });
    }
  }
  const abort = new AbortController();
  const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
  const encoder = new TextEncoder();
  let closed = false;
  let ping: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: Record<string, unknown>) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
          );
        } catch {
          closed = true;
          abort.abort();
        }
      };
      send({
        type: 'message_start',
        message: {
          id: `msg_${crypto.randomUUID().replaceAll('-', '')}`,
          type: 'message',
          role: 'assistant',
          model: request.model,
          content: [],
          stop_reason: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
      ping = setInterval(() => send({ type: 'ping' }), 5_000);
      void (async () => {
        try {
          const response = await runSiderController(request, token, combined, session);
          for (const [index, block] of response.content.entries()) {
            if (block.type === 'tool_use') {
              send({ type: 'content_block_start', index, content_block: { ...block, input: {} } });
              const input = JSON.stringify(block.input);
              for (let offset = 0; offset < input.length; offset += 4000) {
                send({
                  type: 'content_block_delta',
                  index,
                  delta: {
                    type: 'input_json_delta',
                    partial_json: input.slice(offset, offset + 4000),
                  },
                });
              }
            } else if (block.type === 'text') {
              send({
                type: 'content_block_start',
                index,
                content_block: { type: 'text', text: '' },
              });
              send({
                type: 'content_block_delta',
                index,
                delta: { type: 'text_delta', text: block.text },
              });
            }
            send({ type: 'content_block_stop', index });
          }
          send({
            type: 'message_delta',
            delta: { stop_reason: response.stop_reason },
            usage: response.usage,
          });
          send({ type: 'message_stop' });
          logInfo('controller_completed', {
            requestId: context.requestId,
            model: request.model,
            toolCalls: response.content.filter((b) => b.type === 'tool_use').length,
          });
        } catch (error) {
          if (!combined.aborted) {
            send(errorBody(error).body);
            logWarn('controller_failed', {
              requestId: context.requestId,
              message: error instanceof Error ? error.message : '主控失败',
            });
          }
        } finally {
          clearInterval(ping);
          if (!closed) {
            closed = true;
            controller.close();
          }
        }
      })();
    },
    cancel() {
      closed = true;
      clearInterval(ping);
      abort.abort();
    },
  });
  return new Response(stream, {
    headers: {
      ...headers,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  });
}
