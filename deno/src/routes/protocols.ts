import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AnthropicRequest, AnthropicResponse } from '../types/anthropic.ts';
import { getAllModels, getModelById, type ModelInfo } from '../config/models.ts';
import { hybridMessagesRouter } from './messages-hybrid.ts';
import { cancelUpstreamReader } from '../utils/stream-cancel.ts';
import {
  anthropicToGemini,
  anthropicToOpenAIChat,
  anthropicToOpenAIResponse,
  geminiFinishReason,
  type GeminiGenerateRequest,
  geminiToAnthropic,
  type OpenAIChatRequest,
  openAIChatToAnthropic,
  openAIFinishReason,
  type OpenAIResponsesRequest,
  openAIResponsesToAnthropic,
} from '../utils/protocol-adapters.ts';

const protocolRouter = new Hono();

protocolRouter.get('/v1beta/models', (c) => {
  return c.json({
    models: getAllModels().map(toGeminiModel),
  });
});

protocolRouter.get('/v1beta/models/:model', (c) => {
  const modelId = c.req.param('model');
  const model = getModelById(modelId);

  if (!model) {
    return geminiError(`Model '${modelId}' was not found`, 404);
  }

  return c.json(toGeminiModel(model));
});

protocolRouter.post('/v1/chat/completions', async (c) => {
  try {
    const body = await c.req.json() as OpenAIChatRequest;
    const request = openAIChatToAnthropic(body);
    const response = await dispatchAnthropic(c, request);

    if (request.stream) {
      return mapAnthropicStreamToOpenAIChat(response, request.model);
    }

    return await mapJsonResponse(
      response,
      (message) => anthropicToOpenAIChat(message, request.model),
      'openai',
    );
  } catch (error) {
    return openAIError(error, 400);
  }
});

protocolRouter.post('/v1/responses', async (c) => {
  try {
    const body = await c.req.json() as OpenAIResponsesRequest;
    const request = openAIResponsesToAnthropic(body);
    const response = await dispatchAnthropic(c, request);

    if (request.stream) {
      return mapAnthropicStreamToOpenAIResponses(response, request.model);
    }

    return await mapJsonResponse(
      response,
      (message) => anthropicToOpenAIResponse(message, request.model),
      'openai',
    );
  } catch (error) {
    return openAIError(error, 400);
  }
});

protocolRouter.post('/v1beta/models/:modelAction', async (c) => {
  const modelAction = c.req.param('modelAction');
  const streamSuffix = ':streamGenerateContent';
  const generateSuffix = ':generateContent';
  const isStream = modelAction.endsWith(streamSuffix);
  const isGenerate = modelAction.endsWith(generateSuffix);

  if (!isStream && !isGenerate) {
    return geminiError('Unsupported Gemini route', 404);
  }

  const model = modelAction.slice(
    0,
    modelAction.length - (isStream ? streamSuffix.length : generateSuffix.length),
  );
  if (!model) {
    return geminiError('Missing model in Gemini route', 400);
  }

  try {
    const body = await c.req.json() as GeminiGenerateRequest;
    const request = geminiToAnthropic(body, model, isStream);
    const response = await dispatchAnthropic(c, request);

    if (isStream) {
      return mapAnthropicStreamToGemini(response);
    }

    return await mapJsonResponse(response, (message) => anthropicToGemini(message), 'gemini');
  } catch (error) {
    return geminiError(error instanceof Error ? error.message : String(error), 400);
  }
});

async function dispatchAnthropic(c: Context, request: AnthropicRequest): Promise<Response> {
  const headers = new Headers();
  copyRequestHeader(c, headers, 'authorization');
  copyRequestHeader(c, headers, 'x-api-key');
  copyRequestHeader(c, headers, 'anthropic-version');
  copyRequestHeader(c, headers, 'x-conversation-id');
  copyRequestHeader(c, headers, 'x-parent-message-id');
  headers.set('content-type', 'application/json');

  return await hybridMessagesRouter.fetch(
    new Request('http://internal/', {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
    }),
  );
}

function copyRequestHeader(c: Context, headers: Headers, name: string): void {
  const value = c.req.header(name);
  if (value) {
    headers.set(name, value);
  }
}

async function mapJsonResponse(
  response: Response,
  mapper: (response: AnthropicResponse) => unknown,
  errorFormat: 'openai' | 'gemini',
): Promise<Response> {
  if (!response.ok) {
    const message = await extractErrorMessage(response);
    return errorFormat === 'openai'
      ? openAIError(message, response.status)
      : geminiError(message, response.status);
  }

  const anthropic = await response.json() as AnthropicResponse;
  const mapped = Response.json(mapper(anthropic));
  copySessionHeaders(response, mapped);
  return mapped;
}

function copySessionHeaders(from: Response, to: Response): void {
  for (const key of ['x-conversation-id', 'x-assistant-message-id', 'x-user-message-id']) {
    const value = from.headers.get(key);
    if (value) {
      to.headers.set(key, value);
    }
  }
}

async function extractErrorMessage(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const data = JSON.parse(text);
    return data?.error?.message || data?.message || text;
  } catch {
    return text || response.statusText;
  }
}

function openAIError(error: unknown, status: number): Response {
  const message = error instanceof Error ? error.message : String(error);
  return Response.json({
    error: {
      message,
      type: status === 401 ? 'authentication_error' : 'api_error',
      code: null,
    },
  }, { status });
}

function geminiError(message: string, status: number): Response {
  return Response.json({
    error: {
      code: status,
      message,
      status: status === 401
        ? 'UNAUTHENTICATED'
        : status === 404
        ? 'NOT_FOUND'
        : 'INVALID_ARGUMENT',
    },
  }, { status });
}

function toGeminiModel(model: ModelInfo): Record<string, unknown> {
  return {
    name: `models/${model.id}`,
    version: model.id,
    displayName: model.id,
    description: `Sider upstream model ${model.id}`,
    inputTokenLimit: 1_000_000,
    outputTokenLimit: 64_000,
    supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
  };
}

function mapAnthropicStreamToOpenAIChat(response: Response, model: string): Response {
  const id = `chatcmpl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const created = Math.floor(Date.now() / 1000);

  return mapAnthropicSse(response, {
    onEvent(event, send) {
      if (event.type === 'message_start') {
        send({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
        });
        return;
      }

      const delta = event.delta as { type?: string; text?: string; thinking?: string } | undefined;
      if (event.type === 'content_block_delta' && delta?.type === 'text_delta' && delta.text) {
        send({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: { content: delta.text }, finish_reason: null }],
        });
        return;
      }

      if (
        event.type === 'content_block_delta' && delta?.type === 'thinking_delta' && delta.thinking
      ) {
        send({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{
            index: 0,
            delta: { reasoning_content: delta.thinking },
            finish_reason: null,
          }],
        });
        return;
      }

      if (event.type === 'message_delta') {
        const stopReason =
          (event.delta as { stop_reason?: AnthropicResponse['stop_reason'] } | undefined)
            ?.stop_reason;
        send({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: openAIFinishReason(stopReason),
          }],
        });
        return;
      }

      // 上游失败在 Anthropic 流里是 error 事件；丢弃它会让 OpenAI 客户端
      // 只收到空 chunk 流 + [DONE]，无法得知限流或故障。
      if (event.type === 'error') {
        const err = event.error as { message?: string } | undefined;
        send({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          error: { type: 'upstream_error', message: err?.message ?? 'upstream error' },
        });
      }
    },
  });
}

function mapAnthropicStreamToOpenAIResponses(response: Response, model: string): Response {
  const id = `resp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = Math.floor(Date.now() / 1000);
  let text = '';

  return mapAnthropicSse(response, {
    eventPrefix: true,
    onStart(send) {
      send({
        type: 'response.created',
        response: {
          id,
          object: 'response',
          created_at: createdAt,
          status: 'in_progress',
          model,
          output: [],
        },
      }, 'response.created');
    },
    onEvent(event, send) {
      const delta = event.delta as { type?: string; text?: string } | undefined;
      if (event.type === 'content_block_delta' && delta?.type === 'text_delta' && delta.text) {
        text += delta.text;
        send(
          { type: 'response.output_text.delta', delta: delta.text },
          'response.output_text.delta',
        );
        return;
      }

      if (event.type === 'message_delta') {
        send({
          type: 'response.completed',
          response: {
            id,
            object: 'response',
            created_at: createdAt,
            status: 'completed',
            model,
            output: [{
              id: `msg_${id}`,
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text, annotations: [] }],
            }],
            output_text: text,
          },
        }, 'response.completed');
        return;
      }

      // 上游失败在 Anthropic 流里是 error 事件；透传为 Responses API 的 failed 状态，
      // 丢弃它会让客户端只收到 in_progress 后没有下文。
      if (event.type === 'error') {
        const err = event.error as { message?: string } | undefined;
        send({
          type: 'response.failed',
          response: {
            id,
            object: 'response',
            created_at: createdAt,
            status: 'failed',
            error: { code: 'upstream_error', message: err?.message ?? 'upstream error' },
          },
        }, 'response.failed');
      }
    },
  });
}

function mapAnthropicStreamToGemini(response: Response): Response {
  return mapAnthropicSse(response, {
    onEvent(event, send) {
      const delta = event.delta as { type?: string; text?: string } | undefined;
      if (event.type === 'content_block_delta' && delta?.type === 'text_delta' && delta.text) {
        send({
          candidates: [{
            content: { role: 'model', parts: [{ text: delta.text }] },
            index: 0,
          }],
        });
        return;
      }

      if (event.type === 'message_delta') {
        const stopReason =
          (event.delta as { stop_reason?: AnthropicResponse['stop_reason'] } | undefined)
            ?.stop_reason;
        send({
          candidates: [{
            content: { role: 'model', parts: [] },
            finishReason: geminiFinishReason(stopReason),
            index: 0,
          }],
        });
        return;
      }

      // 上游失败在 Anthropic 流里是 error 事件；丢弃它会让 Gemini 客户端
      // 只收到一个空流 + [DONE]，无法得知限流或故障。
      if (event.type === 'error') {
        const err = event.error as { message?: string } | undefined;
        send({ error: { code: 429, message: err?.message ?? 'upstream error', status: 'RESOURCE_EXHAUSTED' } });
      }
    },
  });
}

interface SseMapper {
  eventPrefix?: boolean;
  onStart?: (send: (event: unknown, name?: string) => void) => void;
  onEvent: (event: Record<string, unknown>, send: (event: unknown, name?: string) => void) => void;
}

function mapAnthropicSse(response: Response, mapper: SseMapper): Response {
  if (!response.ok || !response.body) {
    return new Response(response.body, {
      status: response.status,
      headers: response.headers,
    });
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const stream = new ReadableStream({
    async start(controller) {
      const reader = response.body!.getReader();
      const send = (event: unknown, name?: string) => {
        if (mapper.eventPrefix && name) {
          controller.enqueue(encoder.encode(`event: ${name}\n`));
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      mapper.onStart?.(send);

      let buffer = '';
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          buffer = processSseBuffer(buffer, (event) => mapper.onEvent(event, send));
        }

        if (buffer.trim()) {
          processSseBlock(buffer, (event) => mapper.onEvent(event, send));
        }

        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        // `controller.error()` 之后 reader 会一直 locked、上游 body 挂死；
        // 客户端断连导致 enqueue 抛错也走这条路。收口在 finally 里一次覆盖两种出口。
        await cancelUpstreamReader(reader);
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
      'X-Accel-Buffering': 'no',
    },
  });
}

function processSseBuffer(
  buffer: string,
  onEvent: (event: Record<string, unknown>) => void,
): string {
  let rest = buffer.replace(/\r\n/g, '\n');
  let separator = rest.indexOf('\n\n');
  while (separator >= 0) {
    const block = rest.slice(0, separator);
    rest = rest.slice(separator + 2);
    processSseBlock(block, onEvent);
    separator = rest.indexOf('\n\n');
  }
  return rest;
}

function processSseBlock(
  block: string,
  onEvent: (event: Record<string, unknown>) => void,
): void {
  const data = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('\n')
    .trim();

  if (!data || data === '[DONE]') return;

  try {
    const event = JSON.parse(data);
    if (event && typeof event === 'object') {
      onEvent(event as Record<string, unknown>);
    }
  } catch {
    // 忽略无法解析的上游事件，保持流不中断。
  }
}

export default protocolRouter;
