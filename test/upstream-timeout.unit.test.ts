import { expect, test } from 'bun:test';
import { AnthropicApiAdapter, AnthropicBackendError } from '../src/adapters/anthropic-adapter';
import { createUpstreamDeadline, readUpstreamResponse } from '../src/utils/upstream-response';

test('Bun：长工具响应使用上游 SSE 并跨过固定超时窗口', async () => {
  const originalFetch = globalThis.fetch;
  const previous = process.env.DEEPSEEK_REQUEST_TIMEOUT_MS;
  let calls = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    process.env.DEEPSEEK_REQUEST_TIMEOUT_MS = '80';
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
      calls++;
      const body = JSON.parse(init?.body as string);
      expect(body.stream).toBe(true);
      const events = [
        {
          type: 'message_start',
          message: {
            id: 'msg_bun_long',
            model: body.model,
            usage: { input_tokens: 50, output_tokens: 0 },
          },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'tool_1', name: 'Read', input: {} },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"file_path":' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '"/repo/test.md"}' },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } },
        { type: 'message_stop' },
      ];
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              let index = 0;
              const emit = () => {
                if (init?.signal?.aborted) return;
                if (index === events.length) {
                  controller.close();
                  return;
                }
                controller.enqueue(
                  new TextEncoder().encode(`data: ${JSON.stringify(events[index++])}\n\n`),
                );
                timer = setTimeout(emit, 25);
              };
              init?.signal?.addEventListener('abort', () => {
                clearTimeout(timer);
                controller.error(init.signal?.reason);
              }, { once: true });
              emit();
            },
            cancel() {
              clearTimeout(timer);
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      );
    }) as typeof fetch;
    const adapter = new AnthropicApiAdapter({
      enabled: true,
      provider: 'anthropic-compatible',
      baseUrl: 'https://long.example',
      apiKey: 'test-key',
      model: 'glm-5.3-flash',
    });
    const response = await adapter.sendRequest({
      model: 'claude-opus-5.5',
      max_tokens: 4096,
      messages: Array.from(
        { length: 51 },
        (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `历史 ${index}` }),
      ),
      tools: Array.from(
        { length: 18 },
        (_, index) => ({ name: `Tool_${index}`, input_schema: { type: 'object', properties: {} } }),
      ),
    });
    expect(calls).toBe(1);
    expect(response.content[0]).toEqual({
      type: 'tool_use',
      id: 'tool_1',
      name: 'Read',
      input: { file_path: '/repo/test.md' },
    });
    expect(response.usage).toEqual({ input_tokens: 50, output_tokens: 12 });
  } finally {
    clearTimeout(timer);
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env.DEEPSEEK_REQUEST_TIMEOUT_MS;
    else process.env.DEEPSEEK_REQUEST_TIMEOUT_MS = previous;
  }
});

test('Bun：JSON 正文空闲超时取消 reader，并返回可识别的 503', async () => {
  const originalFetch = globalThis.fetch;
  const previous = process.env.DEEPSEEK_REQUEST_TIMEOUT_MS;
  let cancelled = false;
  try {
    process.env.DEEPSEEK_REQUEST_TIMEOUT_MS = '40';
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      )) as typeof fetch;
    const adapter = new AnthropicApiAdapter({
      enabled: true,
      provider: 'deepseek',
      baseUrl: 'https://idle.example',
      apiKey: 'test-key',
      model: 'deepseek-v4-flash',
    });
    try {
      await adapter.sendRequest({
        model: 'claude-opus-5.5',
        messages: [{ role: 'user', content: 'test' }],
      });
      throw new Error('应触发超时');
    } catch (error) {
      expect(error).toBeInstanceOf(AnthropicBackendError);
      expect((error as AnthropicBackendError).statusCode).toBe(503);
    }
    expect(cancelled).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env.DEEPSEEK_REQUEST_TIMEOUT_MS;
    else process.env.DEEPSEEK_REQUEST_TIMEOUT_MS = previous;
  }
});

test('上游 SSE 提前结束不伪造成功工具调用，且释放 reader', async () => {
  const response = new Response(`data: {"type":"message_start","message":{}}\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
  const deadline = createUpstreamDeadline(100);
  try {
    await expect(readUpstreamResponse(response, deadline, () => {})).rejects.toThrow(
      '上游流未完整结束',
    );
  } finally {
    deadline.dispose();
  }
  expect(response.body?.locked).toBe(false);
});
