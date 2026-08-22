import { AnthropicApiAdapter, AnthropicBackendError } from '../src/adapters/anthropic-adapter.ts';
import type { AnthropicRequest } from '../src/types/anthropic.ts';

function assertEquals<T>(actual: T, expected: T) {
  if (actual !== expected) {
    throw new Error(`断言失败：期望 ${String(expected)}，实际 ${String(actual)}`);
  }
}

function assertExists(value: unknown) {
  if (value === undefined || value === null) {
    throw new Error('断言失败：期望值存在');
  }
}

function assertGreaterOrEqual(actual: number, expected: number) {
  if (actual < expected) {
    throw new Error(`断言失败：期望 ${actual} >= ${expected}`);
  }
}

Deno.test('DeepSeek 适配器：用 Anthropic 兼容协议补齐工具能力，并保持对外 Claude 模型名', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit; body: AnthropicRequest }> = [];

  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString();
    const body = JSON.parse(init?.body as string) as AnthropicRequest;
    calls.push({ url, init, body });

    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: 'msg_deepseek_1',
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [{
            type: 'tool_use',
            id: 'toolu_1',
            name: 'Bash',
            input: { command: 'pwd' },
          }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
  }) as typeof fetch;

  try {
    const adapter = new AnthropicApiAdapter({
      enabled: true,
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/anthropic',
      apiKey: 'deepseek-token',
      model: 'deepseek-v4-flash',
    });

    const response = await adapter.sendRequest({
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'user', content: 'run pwd' }],
      max_tokens: 128,
      tools: [{
        name: 'Bash',
        description: 'Run shell',
        input_schema: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
      }],
    });

    assertEquals(calls.length, 1);
    assertEquals(calls[0].url, 'https://api.deepseek.com/anthropic/v1/messages');
    assertEquals(calls[0].body.model, 'deepseek-v4-flash');
    assertEquals(calls[0].body.tools?.[0].name, 'Bash');

    const headers = calls[0].init?.headers as Record<string, string>;
    assertEquals(headers.Authorization, 'Bearer deepseek-token');
    assertEquals(headers['anthropic-version'], '2023-06-01');

    assertEquals(response.model, 'claude-sonnet-4.6');
    assertEquals(response.stop_reason, 'tool_use');
    assertExists(response.content.find((block) => block.type === 'tool_use'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('DeepSeek 适配器：兼容真实上游返回的 thinking 内容块', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as AnthropicRequest;

    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: 'msg_deepseek_thinking_1',
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [{
            type: 'thinking',
            thinking: '先分析问题。',
            signature: 'sig_1',
          }, {
            type: 'text',
            text: '这是最终回答。',
          }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 8, output_tokens: 6 },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
  }) as typeof fetch;

  try {
    const adapter = new AnthropicApiAdapter({
      enabled: true,
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/anthropic',
      apiKey: 'deepseek-token',
      model: 'deepseek-v4-flash',
    });

    const response = await adapter.sendRequest({
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 128,
    });

    assertEquals(response.model, 'claude-sonnet-4.6');
    assertEquals(response.content[0].type, 'thinking');
    assertEquals(response.content[1].type, 'text');
    if (response.content[0].type === 'thinking') {
      assertEquals(response.content[0].thinking, '先分析问题。');
      assertEquals(response.content[0].signature, 'sig_1');
    }
    if (response.content[1].type === 'text') {
      assertEquals(response.content[1].text, '这是最终回答。');
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('DeepSeek 适配器：转发工具历史时转录工具上下文以避免上游 thinking passback 400', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ body: AnthropicRequest & Record<string, unknown> }> = [];

  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as AnthropicRequest & Record<string, unknown>;
    calls.push({ body });

    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: 'msg_deepseek_sanitized_1',
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [{
            type: 'tool_use',
            id: 'toolu_2',
            name: 'Bash',
            input: { command: 'pwd' },
          }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 12, output_tokens: 4 },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
  }) as typeof fetch;

  try {
    const adapter = new AnthropicApiAdapter({
      enabled: true,
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/anthropic',
      apiKey: 'deepseek-token',
      model: 'deepseek-v4-flash',
    });

    await adapter.sendRequest({
      model: 'claude-4.1-opus-think',
      messages: [{
        role: 'assistant',
        content: [{
          type: 'thinking',
          thinking: '历史推理',
          signature: 'sig_2',
        }, {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'Bash',
          input: { command: 'pwd' },
        }],
      }, {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: [{ type: 'text', text: '/repo' }],
        }],
      }],
      max_tokens: 128,
      tools: [{
        name: 'Bash',
        description: 'Run shell',
        input_schema: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
      }],
      tool_choice: { type: 'tool', name: 'Bash' },
      thinking: { type: 'enabled', budget_tokens: 1024 },
    } as unknown as AnthropicRequest);

    assertEquals(calls.length, 1);
    assertEquals(calls[0].body.model, 'deepseek-v4-flash');
    assertEquals(calls[0].body.thinking, undefined);
    assertEquals(calls[0].body.tool_choice, undefined);

    const assistantContent = calls[0].body.messages[0].content;
    if (typeof assistantContent !== 'string') {
      throw new Error('断言失败：期望 assistant content 被转录为文本');
    }
    assertEquals(assistantContent.includes('thinking'), false);
    assertEquals(assistantContent.includes('Previous assistant tool request: name=Bash'), true);
    assertEquals(assistantContent.includes('[tool_use:Bash]'), false);

    const userContent = calls[0].body.messages[1].content;
    if (typeof userContent !== 'string') {
      throw new Error('断言失败：期望 user content 被转录为文本');
    }
    assertEquals(userContent.includes('Previous tool result:'), true);
    assertEquals(userContent.includes('/repo'), true);
    assertEquals(userContent.includes('Tool protocol:'), true);
    assertEquals(userContent.includes('Tool choice requirement: call the tool named "Bash"'), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('DeepSeek 适配器：上游错误保留状态码用于路由层透传', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (() => {
    return Promise.resolve(
      new Response('bad tool_choice', {
        status: 400,
        statusText: 'Bad Request',
      }),
    );
  }) as typeof fetch;

  try {
    const adapter = new AnthropicApiAdapter({
      enabled: true,
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/anthropic',
      apiKey: 'deepseek-token',
      model: 'deepseek-v4-flash',
    });

    try {
      await adapter.sendRequest({
        model: 'claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 128,
      });
      throw new Error('断言失败：期望抛出 AnthropicBackendError');
    } catch (error) {
      if (!(error instanceof AnthropicBackendError)) {
        throw error;
      }
      assertEquals(error.statusCode, 400);
      assertEquals(error.provider, 'deepseek');
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('DeepSeek 适配器：响应耗时包含 body 读取与解析时间', async () => {
  const originalFetch = globalThis.fetch;
  const originalInfo = console.info;
  const infos: Array<{ message: string; data?: Record<string, unknown> }> = [];

  console.info = (message?: unknown, data?: unknown) => {
    infos.push({
      message: String(message),
      data: data && typeof data === 'object' ? data as Record<string, unknown> : undefined,
    });
  };

  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as AnthropicRequest;
    const payload = JSON.stringify({
      id: 'msg_delayed_body',
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const stream = new ReadableStream({
      async start(controller) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        controller.enqueue(new TextEncoder().encode(payload));
        controller.close();
      },
    });

    return Promise.resolve(
      new Response(stream, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof fetch;

  try {
    const adapter = new AnthropicApiAdapter({
      enabled: true,
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/anthropic',
      apiKey: 'deepseek-token',
      model: 'deepseek-v4-flash',
    });

    await adapter.sendRequest({
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 128,
    });

    const responseLog = infos.find((item) =>
      item.message === 'Anthropic-compatible backend response:'
    );
    if (!responseLog?.data || typeof responseLog.data.elapsed !== 'string') {
      throw new Error('断言失败：缺少响应耗时日志');
    }

    const elapsed = Number(responseLog.data.elapsed.replace('ms', ''));
    assertGreaterOrEqual(elapsed, 20);
  } finally {
    globalThis.fetch = originalFetch;
    console.info = originalInfo;
  }
});

Deno.test('DeepSeek adapter converts textual tool transcript into structured tool_use', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as AnthropicRequest;

    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: 'msg_textual_tool',
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [{
            type: 'text',
            text:
              'I need to inspect the file.\n[tool_use:Read] id=call_read_1 input={"file_path":"deno_pro.ts","limit":200}',
          }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 8 },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
  }) as typeof fetch;

  try {
    const adapter = new AnthropicApiAdapter({
      enabled: true,
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/anthropic',
      apiKey: 'deepseek-token',
      model: 'deepseek-v4-flash',
    });

    const response = await adapter.sendRequest({
      model: 'claude-opus-4.6',
      messages: [{ role: 'user', content: 'review deno_pro.ts' }],
      max_tokens: 128,
      tools: [{
        name: 'Read',
        description: 'Read file',
        input_schema: {
          type: 'object',
          properties: {
            file_path: { type: 'string' },
            limit: { type: 'number' },
          },
          required: ['file_path'],
        },
      }],
    });

    assertEquals(response.stop_reason, 'tool_use');
    assertEquals(response.content.length, 2);
    assertEquals(response.content[0].type, 'text');
    assertEquals(response.content[1].type, 'tool_use');
    if (response.content[1].type === 'tool_use') {
      assertEquals(response.content[1].name, 'Read');
      assertEquals(response.content[1].id, 'call_read_1');
      assertEquals(response.content[1].input.file_path, 'deno_pro.ts');
      assertEquals(response.content[1].input.limit, 200);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('DeepSeek adapter sends timeout signal to upstream fetch', async () => {
  const originalFetch = globalThis.fetch;
  const previousTimeout = Deno.env.get('DEEPSEEK_REQUEST_TIMEOUT_MS');
  let signalSeen = false;

  Deno.env.set('DEEPSEEK_REQUEST_TIMEOUT_MS', '12345');
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    signalSeen = init?.signal instanceof AbortSignal;
    const body = JSON.parse(init?.body as string) as AnthropicRequest;

    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: 'msg_timeout_signal',
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
  }) as typeof fetch;

  try {
    const adapter = new AnthropicApiAdapter({
      enabled: true,
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/anthropic',
      apiKey: 'deepseek-token',
      model: 'deepseek-v4-flash',
    });

    await adapter.sendRequest({
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 128,
    });

    assertEquals(signalSeen, true);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousTimeout === undefined) {
      Deno.env.delete('DEEPSEEK_REQUEST_TIMEOUT_MS');
    } else {
      Deno.env.set('DEEPSEEK_REQUEST_TIMEOUT_MS', previousTimeout);
    }
  }
});

/**
 * 以下用例覆盖「Claude Code 提前停下」的根因：
 * 历史工具轮被转录成 `Previous assistant tool request:` 文本后，上游会模仿该格式
 * 输出新的工具调用。若兜底解析器不认识这个格式，响应就退化成纯文本 +
 * stop_reason=end_turn，客户端据此判定回合结束、agent 循环中断。
 */

function stubUpstreamContent(
  content: unknown[],
  stopReason: string | null = 'end_turn',
): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as AnthropicRequest;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: 'msg_textual',
          type: 'message',
          role: 'assistant',
          model: body.model,
          content,
          stop_reason: stopReason,
          usage: { input_tokens: 10, output_tokens: 8 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function newAdapter(): AnthropicApiAdapter {
  return new AnthropicApiAdapter({
    enabled: true,
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/anthropic',
    apiKey: 'deepseek-token',
    model: 'deepseek-v4-flash',
  });
}

const READ_TOOL = {
  name: 'Read',
  description: 'Read file',
  input_schema: {
    type: 'object',
    properties: { file_path: { type: 'string' }, limit: { type: 'number' } },
    required: ['file_path'],
  },
};

Deno.test('DeepSeek adapter 还原 Previous-assistant-tool-request 文本为结构化 tool_use', async () => {
  const restore = stubUpstreamContent([{
    type: 'text',
    text:
      '我需要看一下类型定义。\nPrevious assistant tool request: name=Read id=call_00_ET_v5o8iA3 input_json={"file_path":"deno/src/types/sider.ts","limit":60}',
  }]);

  try {
    const response = await newAdapter().sendRequest({
      model: 'claude-opus-4.6',
      messages: [{ role: 'user', content: 'review sider.ts' }],
      max_tokens: 128,
      tools: [READ_TOOL],
    } as unknown as AnthropicRequest);

    // 核心断言：必须变回 tool_use，否则 Claude Code 会认为回合结束而停下。
    assertEquals(response.stop_reason, 'tool_use');
    assertEquals(response.content.length, 2);
    assertEquals(response.content[0].type, 'text');
    assertEquals(response.content[1].type, 'tool_use');
    if (response.content[1].type === 'tool_use') {
      assertEquals(response.content[1].name, 'Read');
      assertEquals(response.content[1].id, 'call_00_ET_v5o8iA3');
      assertEquals(response.content[1].input.file_path, 'deno/src/types/sider.ts');
      assertEquals(response.content[1].input.limit, 60);
    }
  } finally {
    restore();
  }
});

Deno.test('DeepSeek adapter 还原多行 Previous-assistant-tool-request（log 中的真实形态）', async () => {
  const restore = stubUpstreamContent([{
    type: 'text',
    text: [
      'Previous assistant tool request: name=Read id=call_00_ET input_json={"file_path":"a.ts","limit":60}',
      'Previous assistant tool request: name=Bash id=call_01_6I0z input_json={"command":"grep -n toolUses x.ts","description":"See how toolUses extracted"}',
    ].join('\n'),
  }]);

  try {
    const response = await newAdapter().sendRequest({
      model: 'claude-opus-4.6',
      messages: [{ role: 'user', content: 'inspect' }],
      max_tokens: 128,
      tools: [READ_TOOL, {
        name: 'Bash',
        description: 'Run shell',
        input_schema: {
          type: 'object',
          properties: { command: { type: 'string' }, description: { type: 'string' } },
          required: ['command'],
        },
      }],
    } as unknown as AnthropicRequest);

    assertEquals(response.stop_reason, 'tool_use');
    assertEquals(response.content.length, 2);
    assertEquals(response.content[0].type, 'tool_use');
    assertEquals(response.content[1].type, 'tool_use');
    if (response.content[1].type === 'tool_use') {
      assertEquals(response.content[1].name, 'Bash');
      assertEquals(response.content[1].input.command, 'grep -n toolUses x.ts');
    }
  } finally {
    restore();
  }
});

Deno.test('DeepSeek adapter 不把复述历史的 tool_use id 当成新调用（防重复执行）', async () => {
  const restore = stubUpstreamContent([{
    type: 'text',
    text:
      '回顾一下之前做的事：\nPrevious assistant tool request: name=Bash id=toolu_history_1 input_json={"command":"rm -rf build"}',
  }]);

  try {
    const response = await newAdapter().sendRequest({
      model: 'claude-opus-4.6',
      messages: [{
        role: 'assistant',
        // 这个 id 已经在历史里出现过 —— 模型是在复述，不是发起新调用。
        content: [{
          type: 'tool_use',
          id: 'toolu_history_1',
          name: 'Bash',
          input: { command: 'rm -rf build' },
        }],
      }, {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_history_1', content: 'done' }],
      }],
      max_tokens: 128,
      tools: [{
        name: 'Bash',
        description: 'Run shell',
        input_schema: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
      }],
    } as unknown as AnthropicRequest);

    // 必须保持文本，否则写操作会被重复执行一次。
    assertEquals(response.stop_reason, 'end_turn');
    assertEquals(response.content.length, 1);
    assertEquals(response.content[0].type, 'text');
  } finally {
    restore();
  }
});

Deno.test('DeepSeek adapter 的防模仿提示词禁止实际在用的转录格式', async () => {
  const calls: { body: AnthropicRequest }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as AnthropicRequest;
    calls.push({ body });
    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: 'msg_protocol',
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  }) as typeof fetch;

  try {
    await newAdapter().sendRequest({
      model: 'claude-opus-4.6',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 128,
      tools: [READ_TOOL],
    } as unknown as AnthropicRequest);

    const userContent = calls[0].body.messages[0].content;
    if (typeof userContent !== 'string') {
      throw new Error('断言失败：期望 user content 为文本');
    }
    // 提示词必须点名上下文里真实出现的格式，否则等于没禁。
    assertEquals(userContent.includes('Previous assistant tool request'), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('DeepSeek adapter 保留正常文本，不误判普通句子为工具调用', async () => {
  const restore = stubUpstreamContent([{
    type: 'text',
    text: '这里说明一下 Previous assistant tool request 这个转录格式的来历，但它不是调用。',
  }]);

  try {
    const response = await newAdapter().sendRequest({
      model: 'claude-opus-4.6',
      messages: [{ role: 'user', content: 'explain' }],
      max_tokens: 128,
      tools: [READ_TOOL],
    } as unknown as AnthropicRequest);

    assertEquals(response.stop_reason, 'end_turn');
    assertEquals(response.content.length, 1);
    assertEquals(response.content[0].type, 'text');
  } finally {
    restore();
  }
});

Deno.test('DeepSeek adapter 结构化 tool_use 存在时不触发文本兜底', async () => {
  const restore = stubUpstreamContent([{
    type: 'text',
    text: 'Previous assistant tool request: name=Read id=call_x input_json={"file_path":"a.ts"}',
  }, {
    type: 'tool_use',
    id: 'toolu_real',
    name: 'Read',
    input: { file_path: 'b.ts' },
  }]);

  try {
    const response = await newAdapter().sendRequest({
      model: 'claude-opus-4.6',
      messages: [{ role: 'user', content: 'go' }],
      max_tokens: 128,
      tools: [READ_TOOL],
    } as unknown as AnthropicRequest);

    assertEquals(response.stop_reason, 'tool_use');
    assertEquals(response.content.length, 2);
    // 文本块原样保留，不被拆解。
    assertEquals(response.content[0].type, 'text');
    assertEquals(response.content[1].type, 'tool_use');
  } finally {
    restore();
  }
});
