import { AnthropicApiAdapter } from '../src/adapters/anthropic-adapter.ts';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

for (const clientTool of [false, true]) {
  Deno.test(`上游真流：服务端记录转文本且客户端工具完整，混合=${clientTool}`, async () => {
    const originalFetch = globalThis.fetch;
    const result = {
      type: 'web_search_tool_result',
      tool_use_id: 'srv_1',
      content: [
        { type: 'web_search_result', url: 'https://example.com/source', title: '来源' },
        { type: 'web_search_tool_result_error', error_code: 'unavailable' },
      ],
    };
    const rawEvents = [
      { type: 'message_start', message: { model: 'glm-5.3-flash', content: [] } },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: {} },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"query":' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '"北京"}' },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: result },
      { type: 'content_block_stop', index: 1 },
      ...(clientTool
        ? [
          {
            type: 'content_block_start',
            index: 2,
            content_block: {
              type: 'tool_use',
              id: 'client_1',
              name: 'mcp__webReader__read',
              input: {},
            },
          },
          {
            type: 'content_block_delta',
            index: 2,
            delta: { type: 'input_json_delta', partial_json: '{"url":"https://example.com"}' },
          },
          { type: 'content_block_stop', index: 2 },
        ]
        : []),
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ];
    let cancelled = 0;
    try {
      globalThis.fetch = (() => {
        const raw = rawEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
        const bytes = new TextEncoder().encode(raw);
        let offset = 0;
        return Promise.resolve(
          new Response(
            new ReadableStream({
              pull(controller) {
                if (offset < bytes.length) {
                  controller.enqueue(bytes.slice(offset, offset + 13));
                  offset += 13;
                } else controller.close();
              },
              cancel() {
                cancelled++;
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          ),
        );
      }) as typeof fetch;
      const adapter = new AnthropicApiAdapter({
        enabled: true,
        provider: 'anthropic-compatible',
        baseUrl: 'https://stream.example/anthropic',
        apiKey: 'test-key',
        model: 'glm-5.3-flash',
      });
      const batches = await Promise.all([0, 1].map(async () => {
        const events: Record<string, unknown>[] = [];
        let completed = false;
        let error: Error | undefined;
        await adapter.sendStreamRequest(
          {
            model: 'claude-opus-5.5',
            max_tokens: 1024,
            messages: [{ role: 'user', content: '查询网页' }],
          },
          (chunk) => events.push(chunk as Record<string, unknown>),
          () => {
            completed = true;
          },
          (e) => {
            error = e;
          },
        );
        assert(!error && completed, `流应正常完成：${error?.message}`);
        return events;
      }));
      for (const events of batches) {
        const starts = events.filter((event) => event.type === 'content_block_start');
        assert(
          starts.every((event) =>
            ['text', 'tool_use'].includes((event.content_block as { type: string }).type)
          ),
          '禁止泄漏服务端工具块',
        );
        const deltas = events.filter((event) => event.type === 'content_block_delta');
        const text = deltas.map((event) => (event.delta as { text?: string }).text ?? '').join('');
        assert(
          text.includes('北京') && text.includes('https://example.com/source') &&
            text.includes('unavailable'),
          '输入、来源与错误必须保留',
        );
        assert(
          events.filter((event) => event.type === 'content_block_stop').length === starts.length,
          '内容块闭合',
        );
        assert(
          (events[0].message as { model: string }).model === 'claude-opus-5.5',
          '对外模型保持一致',
        );
        assert(
          (events.find((event) => event.type === 'message_delta')?.delta as { stop_reason: string })
            .stop_reason === (clientTool ? 'tool_use' : 'end_turn'),
          '服务端工具不要求客户端执行',
        );
        if (clientTool) {
          assert(
            JSON.stringify(deltas.find((event) => event.index === 2)) ===
              JSON.stringify(
                rawEvents.find((event) =>
                  event.index === 2 && event.type === 'content_block_delta'
                ),
              ),
            'MCP 输入增量原样保留',
          );
        }
      }
      assert(cancelled === 0, '完整读取后不会中途取消');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

Deno.test('上游真流：畸形服务端输入报错并取消上游 reader', async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  try {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              for (
                const event of [
                  {
                    type: 'content_block_start',
                    index: 0,
                    content_block: {
                      type: 'server_tool_use',
                      id: 'srv_bad',
                      name: 'web_search',
                      input: {},
                    },
                  },
                  {
                    type: 'content_block_delta',
                    index: 0,
                    delta: { type: 'input_json_delta', partial_json: 'invalid' },
                  },
                  { type: 'content_block_stop', index: 0 },
                ]
              ) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      )) as typeof fetch;
    const adapter = new AnthropicApiAdapter({
      enabled: true,
      provider: 'deepseek',
      baseUrl: 'https://stream.example',
      apiKey: 'test-key',
      model: 'deepseek-v4-flash',
    });
    let error: Error | undefined;
    let completed = false;
    await adapter.sendStreamRequest(
      { model: 'claude-opus-5.5', messages: [{ role: 'user', content: 'test' }] },
      () => {},
      () => {
        completed = true;
      },
      (e) => {
        error = e;
      },
    );
    assert(!!error && !completed && cancelled, '解析失败必须报错且取消上游');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
