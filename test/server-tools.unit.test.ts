import { expect, test } from 'bun:test';
import { Hono } from 'hono';
import { AnthropicApiAdapter } from '../src/adapters/anthropic-adapter';
import type { AnthropicRequest } from '../src/types/anthropic';

for (const variant of ['server', 'mixed', 'generic', 'generic-mixed']) {
  const clientTool = variant.includes('mixed');
  test(`兼容上游服务端工具：Bun 合成流与历史回传，结果变体=${variant}`, async () => {
    const vars = {
      AUTH_TOKEN: 'test-token-12345',
      DEEPSEEK_API_KEY: 'upstream-token',
      DEEPSEEK_BASE_URL: 'https://server-tools.example/anthropic',
      DEEPSEEK_MODEL: 'glm-5.3-flash',
      DEFAULT_BACKEND: 'deepseek',
      SIDER_AUTH_TOKEN: 'sider-token',
    };
    const previous = new Map(Object.keys(vars).map((key) => [key, process.env[key]]));
    const originalFetch = globalThis.fetch;
    const calls: AnthropicRequest[] = [];
    const serverUse = {
      type: 'server_tool_use',
      id: 'srvtoolu_fetch',
      name: 'web_fetch',
      input: { url: 'https://example.com/weather' },
    };
    const serverResult = {
      type: variant.startsWith('generic') ? 'tool_result' : 'web_fetch_tool_result',
      tool_use_id: serverUse.id,
      content: variant === 'generic'
        ? '北京晴天。'
        : variant === 'generic-mixed'
        ? [{ type: 'text', text: '北京晴天。' }]
        : {
          type: 'web_fetch_result',
          url: serverUse.input.url,
          content: {
            type: 'document',
            source: { type: 'text', media_type: 'text/plain', data: '北京晴天。' },
          },
        },
    };
    const content = [
      serverUse,
      serverResult,
      { type: 'text', text: '北京晴天。' },
      ...(clientTool
        ? [{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: 'a.ts' } }]
        : []),
    ];

    try {
      Object.assign(process.env, vars);
      globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
        calls.push(JSON.parse(init?.body as string));
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 'msg_server_tools',
              type: 'message',
              role: 'assistant',
              model: 'glm-5.3-flash',
              content,
              stop_reason: 'end_turn',
              usage: { input_tokens: 12, output_tokens: 9 },
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
        );
      }) as typeof fetch;
      const routeModule = await import(
        `../src/routes/messages-hybrid.ts?test=${crypto.randomUUID()}`
      );
      const app = new Hono();
      app.route('/v1/messages', routeModule.hybridMessagesRouter);
      const request = {
        model: 'claude-opus-5.5',
        max_tokens: 1024,
        stream: true,
        messages: [{ role: 'user', content: '你好' }, { role: 'assistant', content: '你好' }, {
          role: 'user',
          content: `查询北京天气 ${crypto.randomUUID()}`,
        }],
        tools: Array.from({ length: 17 }, (_, index) => ({
          name: index === 0 ? 'Read' : `Tool_${index}`,
          input_schema: { type: 'object', properties: {} },
        })),
      };
      const post = (body: unknown) =>
        app.request('/v1/messages?beta=true', {
          method: 'POST',
          headers: { authorization: 'Bearer test-token-12345', 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      const response = await post(request);
      expect(response.status).toBe(200);
      const events = (await response.text()).split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => JSON.parse(line.slice(5).trim()));
      expect(events.some((event) => event.type === 'error')).toBe(false);
      const starts = events.filter((event) => event.type === 'content_block_start');
      expect(
        starts.every((event) =>
          ['text', 'thinking', 'redacted_thinking', 'tool_use'].includes(event.content_block.type)
        ),
      ).toBe(true);
      expect(starts[0].content_block.type).toBe('text');
      expect(
        events.find((event) => event.index === 0 && event.type === 'content_block_delta')?.delta,
      )
        .toMatchObject({ type: 'text_delta' });
      expect(
        events.filter((event) => event.type === 'content_block_delta').map((event) =>
          event.delta.text ?? ''
        ).join(''),
      ).toContain(serverUse.input.url);
      expect(starts[1].content_block.type).toBe('text');
      expect(starts).toHaveLength(content.length);
      expect(events.filter((event) => event.type === 'content_block_stop')).toHaveLength(
        content.length,
      );
      expect(events.at(-1)?.type).toBe('message_stop');
      expect(events.find((event) => event.type === 'message_delta')?.delta.stop_reason)
        .toBe(clientTool ? 'tool_use' : 'end_turn');
      expect(calls[0].model).toBe('glm-5.3-flash');
      expect(calls[0].messages).toHaveLength(3);
      expect(calls[0].tools).toHaveLength(17);

      const followup = await post({
        ...request,
        stream: false,
        messages: [request.messages[0], { role: 'assistant', content }, {
          role: 'user',
          content: '根据刚才抓取的网页回答',
        }],
      });
      expect(followup.status).toBe(200);
      const body = await followup.json();
      expect(body.model).toBe('claude-opus-5.5');
      expect(
        body.content.every((block: { type: string }) =>
          ['text', 'thinking', 'redacted_thinking', 'tool_use'].includes(block.type)
        ),
      ).toBe(true);
      expect(JSON.stringify(body.content)).toContain('srvtoolu_fetch');
      expect(JSON.stringify(body.content)).toContain('北京晴天。');
      if (clientTool) expect(body.content.at(-1)).toEqual(content.at(-1));
      expect(String(calls[1].messages[1].content)).toContain('srvtoolu_fetch');
      expect(String(calls[1].messages[1].content)).toContain('北京晴天。');
    } finally {
      globalThis.fetch = originalFetch;
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
}

test('兼容上游服务端工具：保留代码执行结果及错误，不放行未知内容块', async () => {
  const originalFetch = globalThis.fetch;
  const adapter = new AnthropicApiAdapter({
    enabled: true,
    provider: 'anthropic-compatible',
    baseUrl: 'https://server-tools.example/anthropic',
    apiKey: 'upstream-token',
    model: 'glm-5.3-flash',
  });
  const request: AnthropicRequest = {
    model: 'claude-opus-5.5',
    max_tokens: 1024,
    messages: [{ role: 'user', content: '执行计算' }],
  };
  try {
    for (
      const type of [
        'code_execution_tool_result',
        'bash_code_execution_tool_result',
        'text_editor_code_execution_tool_result',
        'web_search_tool_result',
        'web_fetch_tool_result',
        'unknown_content_block',
      ]
    ) {
      const result = {
        type,
        tool_use_id: 'srvtoolu_1',
        content: { type: 'tool_result_error', error_code: 'unavailable' },
      };
      globalThis.fetch = (() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              content: [result, { type: 'text', text: '工具暂时不可用。' }],
              stop_reason: 'end_turn',
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
        )) as typeof fetch;
      if (type === 'unknown_content_block') {
        await expect(adapter.sendRequest(request)).rejects.toThrow(
          'unsupported content block type',
        );
      } else {
        const response = await adapter.sendRequest(request);
        expect(response.content[0].type).toBe('text');
        expect(JSON.stringify(response.content[0])).toContain('unavailable');
        expect(response.stop_reason).toBe('end_turn');
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

for (const upstream of ['glm-5.3-flash', 'deepseek-v4-flash']) {
  test(`客户端工具与服务端结果的结束语义，模型=${upstream}`, async () => {
    const originalFetch = globalThis.fetch;
    const adapter = new AnthropicApiAdapter({
      enabled: true,
      provider: 'anthropic-compatible',
      baseUrl: 'https://contract.example',
      apiKey: 'test-key',
      model: upstream,
    });
    const result = {
      type: 'tool_result',
      tool_use_id: 'srv_done',
      is_error: true,
      content: '[tool_use:Bash] id=must_not_execute input={"command":"echo replay"}',
    };
    try {
      for (const clientTool of [false, true]) {
        const tool = {
          type: 'tool_use',
          id: 'client_live',
          name: 'mcp__webReader__read',
          input: { url: 'https://example.com' },
        };
        globalThis.fetch = (() =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                content: [
                  result,
                  { type: 'text', text: '上游工具失败，需要另行获取资料。' },
                  ...(clientTool ? [tool] : []),
                ],
                stop_reason: 'tool_use',
                usage: { input_tokens: 10, output_tokens: 9, cache_read_input_tokens: 123 },
              }),
              { headers: { 'content-type': 'application/json' } },
            ),
          )) as typeof fetch;
        const response = await adapter.sendRequest({
          model: 'claude-opus-5.5',
          max_tokens: 1024,
          stop_sequences: ['echo'],
          messages: [{ role: 'user', content: '获取资料' }],
        });
        expect(response.content[0].type).toBe('text');
        expect(JSON.stringify(response.content[0])).toContain('is_error');
        expect(JSON.stringify(response.content[0])).toContain('must_not_execute');
        expect(response.content.filter((block) => block.type === 'tool_use')).toHaveLength(
          clientTool ? 1 : 0,
        );
        if (clientTool) expect(response.content.at(-1)).toEqual(tool);
        expect(response.stop_reason).toBe(clientTool ? 'tool_use' : 'end_turn');
        expect(response.usage.cache_read_input_tokens).toBe(123);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}
