import { AnthropicApiAdapter, AnthropicBackendError } from '../src/adapters/anthropic-adapter.ts';
import { createUpstreamDeadline } from '../src/utils/upstream-response.ts';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

Deno.test('51 消息 18 工具：持续生成超过超时窗口仍完成，输入完整且不重复请求', async () => {
  const originalFetch = globalThis.fetch;
  const previous = Deno.env.get('DEEPSEEK_REQUEST_TIMEOUT_MS');
  let calls = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    Deno.env.set('DEEPSEEK_REQUEST_TIMEOUT_MS', '80');
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
      calls++;
      const body = JSON.parse(init?.body as string);
      assert(body.stream === true, '工具请求也必须流式获取上游进度');
      assert(body.messages.length === 51 && body.tools.length === 18, '保留全部消息和工具');
      const events = [
        {
          type: 'message_start',
          message: {
            id: 'msg_long',
            model: body.model,
            content: [],
            usage: { input_tokens: 123, output_tokens: 0 },
          },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'tool_long', name: 'Read', input: {} },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"file_path":' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '"/repo/source.md"}' },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } },
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
    const start = Date.now();
    const response = await adapter.sendRequest({
      model: 'claude-opus-5.5',
      max_tokens: 4096,
      messages: Array.from(
        { length: 51 },
        (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `历史 ${i}` }),
      ),
      tools: Array.from(
        { length: 18 },
        (_, i) => ({
          name: i === 0 ? 'Read' : `Tool_${i}`,
          input_schema: { type: 'object', properties: { file_path: { type: 'string' } } },
        }),
      ),
    });
    assert(Date.now() - start > 80 && calls === 1, '长响应完成且不重复上游调用');
    assert(
      response.stop_reason === 'tool_use' && response.content[0].type === 'tool_use',
      '工具结束语义',
    );
    if (response.content[0].type === 'tool_use') {
      assert(response.content[0].input.file_path === '/repo/source.md', '增量输入完整');
    }
    assert(
      response.usage.input_tokens === 123 && response.usage.output_tokens === 20,
      '流式 usage 合并',
    );
  } finally {
    clearTimeout(timer);
    globalThis.fetch = originalFetch;
    if (previous === undefined) Deno.env.delete('DEEPSEEK_REQUEST_TIMEOUT_MS');
    else Deno.env.set('DEEPSEEK_REQUEST_TIMEOUT_MS', previous);
  }
});

Deno.test('上游正文卡住：空闲超时返回 503，取消连接且不自动重试', async () => {
  const originalFetch = globalThis.fetch;
  const previous = Deno.env.get('DEEPSEEK_REQUEST_TIMEOUT_MS');
  let calls = 0;
  let body: ReadableStream<Uint8Array> | undefined;
  try {
    Deno.env.set('DEEPSEEK_REQUEST_TIMEOUT_MS', '40');
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
      calls++;
      body = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), {
            once: true,
          });
        },
      });
      return Promise.resolve(
        new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
      );
    }) as typeof fetch;
    const adapter = new AnthropicApiAdapter({
      enabled: true,
      provider: 'anthropic-compatible',
      baseUrl: 'https://idle.example',
      apiKey: 'test-key',
      model: 'glm-5.3-flash',
    });
    let caught: unknown;
    try {
      await adapter.sendRequest({
        model: 'claude-opus-5.5',
        messages: [{ role: 'user', content: '读取' }],
      });
    } catch (e) {
      caught = e;
    }
    assert(
      caught instanceof AnthropicBackendError && caught.statusCode === 503,
      '超时必须是明确的 503 后端错误',
    );
    assert(calls === 1, '已经执行过的上游工具不能因超时被盲目重试');
    assert(body?.locked === false, '已 error 的流必须释放 reader');
  } finally {
    globalThis.fetch = originalFetch;
    if (previous === undefined) Deno.env.delete('DEEPSEEK_REQUEST_TIMEOUT_MS');
    else Deno.env.set('DEEPSEEK_REQUEST_TIMEOUT_MS', previous);
  }
});

Deno.test('持续心跳也受独立总时长限制，完成后清理计时器', async () => {
  const deadline = createUpstreamDeadline(80, 140);
  const timer = setInterval(deadline.touch, 20);
  try {
    await new Promise<void>((resolve) =>
      deadline.signal.addEventListener('abort', () => resolve(), { once: true })
    );
    assert(deadline.signal.reason.timeoutPhase === 'total', '活动不能绕过总时长限制');
  } finally {
    clearInterval(timer);
    deadline.dispose();
  }
});
