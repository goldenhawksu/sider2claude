import { recordSiderActivity } from './sider-activity.ts';
import { getEnv } from './env.ts';
import type { AnthropicRequest } from '../types/anthropic.ts';
import {
  ControllerError,
  type ControllerTextSink,
  runSiderController,
} from './sider-controller.ts';
import { SiderUpstreamError } from './sse-line-reader.ts';
import { logInfo, logWarn, type RequestLogContext } from './request-observability.ts';

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
/**
 * 流式请求的提交窗口：首个内容产出前最多等待这么久才发出 HTTP 200 与 SSE 头。
 * 窗口内失败（1135 限流、冷却、登记检查点）返回真正的 HTTP 错误与 Retry-After；
 * 否则客户端只能在 200 的流里看到 error 事件，拿不到退避时长，会立即盲目重试。
 * 设为 0 恢复旧行为（立即提交）。
 */
export function streamCommitWindowMs(): number {
  const value = Number(getEnv('SIDER_CONTROLLER_STREAM_COMMIT_MS', '20000'));
  return Number.isFinite(value) && value >= 0 ? value : 20000;
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
      recordSiderActivity(
        request.model,
        error instanceof ControllerError && error.statusCode === 429 &&
          /^上下文登记(?:进度|达到本次时限)/.test(error.message)
          ? { checkpointResponses: 1 }
          : { requestFailures: 1 },
      );
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
  // 首个内容产出（或完成、或窗口到期）才提交流；之前的失败改走 HTTP 错误。
  let committed = false;
  let decide!: (outcome: { kind: 'commit' } | { kind: 'error'; error: unknown }) => void;
  const decision = new Promise<{ kind: 'commit' } | { kind: 'error'; error: unknown }>(
    (resolve) => (decide = resolve),
  );
  const commit = () => {
    if (committed) return;
    committed = true;
    decide({ kind: 'commit' });
  };
  const commitWindowMs = streamCommitWindowMs();
  // 0 表示旧行为：立即提交，不进入延迟窗口。
  if (commitWindowMs === 0) commit();
  const commitTimer = commitWindowMs > 0 ? setTimeout(commit, commitWindowMs) : undefined;
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
      // 无工具回答边收边发；工具轮的文本必须整段缓冲后还原，不使用这个出口。
      let textStarted = false;
      let textClosed = false;
      let streamed = '';
      const sink: ControllerTextSink = {
        onTextDelta(text: string) {
          if (!text || closed) return;
          commit();
          if (!textStarted) {
            textStarted = true;
            send({
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' },
            });
          }
          streamed += text;
          send({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text },
          });
        },
      };
      void (async () => {
        try {
          const response = await runSiderController(request, token, combined, session, sink);
          commit();
          for (const [index, block] of response.content.entries()) {
            if (block.type === 'text' && textStarted) {
              // 文本已经实时下发过；最终文本更长时只补发尾部，避免重复。
              if (block.text.length > streamed.length && block.text.startsWith(streamed)) {
                send({
                  type: 'content_block_delta',
                  index: 0,
                  delta: { type: 'text_delta', text: block.text.slice(streamed.length) },
                });
              } else if (block.text !== streamed) {
                logWarn('controller_stream_text_mismatch', {
                  requestId: context.requestId,
                  streamedChars: streamed.length,
                  finalChars: block.text.length,
                });
              }
              if (!textClosed) {
                textClosed = true;
                send({ type: 'content_block_stop', index: 0 });
              }
              continue;
            }
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
            delta: {
              stop_reason: response.stop_reason,
              ...(response.stop_sequence ? { stop_sequence: response.stop_sequence } : {}),
            },
            usage: response.usage,
          });
          send({ type: 'message_stop' });
          logInfo('controller_completed', {
            requestId: context.requestId,
            model: request.model,
            toolCalls: response.content.filter((b) => b.type === 'tool_use').length,
          });
        } catch (error) {
          recordSiderActivity(
            request.model,
            error instanceof ControllerError && error.statusCode === 429 &&
              /^上下文登记(?:进度|达到本次时限)/.test(error.message)
              ? { checkpointResponses: 1 }
              : { requestFailures: 1 },
          );
          if (!committed) {
            // 还没提交流：交给外层返回带状态码与 Retry-After 的 HTTP 错误。
            committed = true;
            decide({ kind: 'error', error });
            return;
          }
          if (textStarted && !textClosed) {
            textClosed = true;
            send({ type: 'content_block_stop', index: 0 });
          }
          if (!combined.aborted) {
            send(errorBody(error).body);
            logWarn('controller_failed', {
              requestId: context.requestId,
              message: error instanceof Error ? error.message : '主控失败',
            });
          }
        } finally {
          clearInterval(ping);
          clearTimeout(commitTimer);
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
      clearTimeout(commitTimer);
      abort.abort();
    },
  });
  const outcome = await decision;
  if (outcome.kind === 'error') {
    const { error } = outcome;
    const { status, body } = errorBody(error);
    logWarn('controller_failed', {
      requestId: context.requestId,
      status,
      stream: true,
      committed: false,
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
  return new Response(stream, {
    headers: {
      ...headers,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  });
}
