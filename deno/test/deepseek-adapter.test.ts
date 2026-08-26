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
    // 防模仿提示词挂在 system 上（见 prompt-cache.test.ts：挂消息尾部会打断上游缓存前缀）；
    // tool_choice 是逐轮变化的要求，仍然挂在最后一条 user 消息上。
    assertEquals(String(calls[0].body.system).includes('Tool protocol:'), true);
    assertEquals(userContent.includes('Tool protocol:'), false);
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

    const systemContent = String(calls[0].body.system);
    // 提示词必须点名上下文里真实出现的格式，否则等于没禁。
    assertEquals(systemContent.includes('Previous assistant tool request'), true);
    // 它必须在 system 上，不能在消息尾部——挂消息尾部会让同一条历史消息在
    // 下一轮少掉这段后缀，上游 prefix 缓存必然在那里断掉（见 prompt-cache.test.ts）。
    const userContent = calls[0].body.messages[0].content;
    if (typeof userContent !== 'string') {
      throw new Error('断言失败：期望 user content 为文本');
    }
    assertEquals(userContent.includes('Tool protocol:'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/**
 * Windows 路径回归：模型模仿转录格式时，会把 JSON.stringify 产出的 `C:\\Users`
 * 按人类写法还原成单反斜杠 `C:\Users`。这不是合法 JSON，JSON.parse 会抛
 * "Bad escaped character"，兜底随即失效 → end_turn → Claude Code 停止。
 * 下面两行是生产 log 里的原始数据。
 */
Deno.test('DeepSeek adapter 还原含未转义 Windows 路径的转录（生产 log 原文·Grep）', async () => {
  const restore = stubUpstreamContent([{
    type: 'text',
    text: String
      .raw`Previous assistant tool request: name=Grep id=call_00_GfLr3D3R4w0ExT73Udb1p8469 input_json={"-n":true,"output_mode":"content","path":"d:\Github_repo\sider2api\deno_pro.ts","pattern":"stats.json"}`,
  }]);

  try {
    const response = await newAdapter().sendRequest({
      model: 'claude-opus-4.6',
      messages: [{ role: 'user', content: 'find stats route' }],
      max_tokens: 128,
      tools: [READ_TOOL],
    } as unknown as AnthropicRequest);

    assertEquals(response.stop_reason, 'tool_use');
    assertEquals(response.content[0].type, 'tool_use');
    if (response.content[0].type === 'tool_use') {
      assertEquals(response.content[0].name, 'Grep');
      // 反斜杠必须原样保留成路径分隔符，不能被吃掉或变成转义字符。
      assertEquals(response.content[0].input.path, 'd:\\Github_repo\\sider2api\\deno_pro.ts');
      assertEquals(response.content[0].input['-n'], true);
      assertEquals(response.content[0].input.output_mode, 'content');
    }
  } finally {
    restore();
  }
});

Deno.test('DeepSeek adapter 还原含未转义 Windows 路径的转录（生产 log 原文·Read）', async () => {
  const restore = stubUpstreamContent([{
    type: 'text',
    text: String
      .raw`Previous assistant tool request: name=Read id=call_00_ET_v5o8iA3 input_json={"file_path":"C:\Users\Weihong\AppData\Local\Temp\ref\sider.ts","limit":60,"offset":140}`,
  }]);

  try {
    const response = await newAdapter().sendRequest({
      model: 'claude-opus-4.6',
      messages: [{ role: 'user', content: 'read types' }],
      max_tokens: 128,
      tools: [READ_TOOL],
    } as unknown as AnthropicRequest);

    assertEquals(response.stop_reason, 'tool_use');
    if (response.content[0].type === 'tool_use') {
      assertEquals(
        response.content[0].input.file_path,
        'C:\\Users\\Weihong\\AppData\\Local\\Temp\\ref\\sider.ts',
      );
      assertEquals(response.content[0].input.limit, 60);
      assertEquals(response.content[0].input.offset, 140);
    }
  } finally {
    restore();
  }
});

Deno.test('DeepSeek adapter 修复未转义反斜杠时不破坏合法转义序列', async () => {
  const restore = stubUpstreamContent([{
    type: 'text',
    // \n \t \" \\ 都是合法 JSON 转义，必须原样生效；只有 \G \s 这类非法的才补救。
    text: String
      .raw`Previous assistant tool request: name=Bash id=call_esc input_json={"command":"echo \"hi\"\nls\tx","description":"a\\b","path":"d:\Github_repo"}`,
  }]);

  try {
    const response = await newAdapter().sendRequest({
      model: 'claude-opus-4.6',
      messages: [{ role: 'user', content: 'run' }],
      max_tokens: 128,
      tools: [READ_TOOL],
    } as unknown as AnthropicRequest);

    assertEquals(response.stop_reason, 'tool_use');
    if (response.content[0].type === 'tool_use') {
      assertEquals(response.content[0].input.command, 'echo "hi"\nls\tx');
      assertEquals(response.content[0].input.description, 'a\\b');
      assertEquals(response.content[0].input.path, 'd:\\Github_repo');
    }
  } finally {
    restore();
  }
});

Deno.test('DeepSeek adapter 对真正无法解析的 input_json 保持文本，不伪造工具调用', async () => {
  const restore = stubUpstreamContent([{
    type: 'text',
    // 花括号不闭合 —— 补救反斜杠也救不回来，必须老实退回文本。
    text:
      'Previous assistant tool request: name=Read id=call_broken input_json={"file_path":"a.ts",',
  }]);

  try {
    const response = await newAdapter().sendRequest({
      model: 'claude-opus-4.6',
      messages: [{ role: 'user', content: 'x' }],
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

Deno.test('DeepSeek adapter 反斜杠修补的边界情形', async () => {
  const cases: Array<{ name: string; json: string; expect: Record<string, unknown> }> = [
    {
      name: 'Windows 路径里 \\r \\b \\t \\n \\f 开头的目录名都不被吃掉',
      json: String.raw`{"a":"C:\ref\bin\temp\node_modules\files\x.ts","b":"d:\Github_repo\build"}`,
      expect: {
        a: 'C:\\ref\\bin\\temp\\node_modules\\files\\x.ts',
        b: 'd:\\Github_repo\\build',
      },
    },
    {
      // 已知局限：UNC 路径没有盘符前缀，识别不出「整体是路径」，因而走
      // 非路径分支——`\r`/`\b` 这类合法转义仍会生效（`\report` → 回车+eport）。
      // 关键是整体仍能解析、不退回文本，不会让 agent 循环停止。
      // Claude Code 场景里 UNC 路径极少出现，暂不为它引入更激进的启发式。
      name: 'UNC 路径（合法转义仍生效，属已知局限）',
      json: String.raw`{"p":"\\server\share\report.txt"}`,
      expect: { p: '\\server\\share\report.txt' },
    },
    {
      name: '非路径字符串里的合法转义仍然生效',
      json: String.raw`{"cmd":"echo \"hi\"\nls\tx","re":"a\\b"}`,
      expect: { cmd: 'echo "hi"\nls\tx', re: 'a\\b' },
    },
    {
      name: '正则/glob 里的非法转义被补救',
      json: String.raw`{"pattern":"\d+\s*\w","glob":"**/*.ts"}`,
      expect: { pattern: '\\d+\\s*\\w', glob: '**/*.ts' },
    },
    {
      name: '含转义引号的路径',
      json: String.raw`{"path":"C:\a b\c.ts","q":"say \"hi\""}`,
      expect: { path: 'C:\\a b\\c.ts', q: 'say "hi"' },
    },
    {
      name: '已正确转义的路径不被二次转义',
      json: String.raw`{"path":"C:\\Users\\a.ts"}`,
      expect: { path: 'C:\\Users\\a.ts' },
    },
    {
      // 已知局限：这一串本身就是合法 JSON（`\t` 是制表符转义），严格解析即成功，
      // 修补逻辑根本不会被触发，因此 `d:\tmp` 得到的是 `d:` + TAB + `mp`。
      // 只有当整串解析失败时我们才有机会介入——单个歧义 token 无从消歧。
      // 实践中这类路径极少（`\tmp` 需正好跟在盘符后），且不会中断 agent 循环。
      name: 'unicode 转义保留（\\t 歧义属已知局限）',
      json: String.raw`{"s":"\u4e2d\u6587","p":"d:\tmp"}`,
      expect: { s: '中文', p: 'd:\tmp' },
    },
    {
      name: '非字符串值不受影响',
      json: String.raw`{"n":42,"b":true,"nul":null,"arr":[1,2],"p":"c:\x"}`,
      expect: { n: 42, b: true, nul: null, p: 'c:\\x' },
    },
  ];

  for (const testCase of cases) {
    const restore = stubUpstreamContent([{
      type: 'text',
      text: `Previous assistant tool request: name=Read id=call_edge input_json=${testCase.json}`,
    }]);

    try {
      const response = await newAdapter().sendRequest({
        model: 'claude-opus-4.6',
        messages: [{ role: 'user', content: 'x' }],
        max_tokens: 128,
        tools: [READ_TOOL],
      } as unknown as AnthropicRequest);

      if (response.content[0].type !== 'tool_use') {
        throw new Error(`边界用例「${testCase.name}」未还原成 tool_use`);
      }

      const input = response.content[0].input;
      for (const [key, want] of Object.entries(testCase.expect)) {
        const got = input[key];
        if (got !== want) {
          throw new Error(
            `边界用例「${testCase.name}」字段 ${key}：期望 ${JSON.stringify(want)}，实际 ${
              JSON.stringify(got)
            }`,
          );
        }
      }
      // 数组要单独比，=== 比不了。
      if ('arr' in testCase.expect === false && Array.isArray(input.arr)) {
        assertEquals(JSON.stringify(input.arr), '[1,2]');
      }
    } finally {
      restore();
    }
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

/**
 * 未转义的内层双引号。
 *
 * 这是「Claude Code 每隔几轮就停下、要人说『请继续』」的实测根因：转录格式被
 * 模型模仿后，只要命令里带引号（`echo "x"`、`python -c "…"`、`curl -H "…"`，
 * 也就是绝大多数 Bash 调用），产出的 input_json 就不是合法 JSON，兜底解析
 * 失败，响应退化成 stop_reason=end_turn，客户端据此结束回合。
 *
 * 修复靠 schema 制导：一个 `"` 只有在其后紧跟 `,"<本工具声明过的键>":` 时
 * 才算值结束。通用 JSON 修复器没有 schema，只能在「截断」与「合并」之间赌，
 * 赌错方向会把 `rm -rf /tmp/x` 截成 `rm -rf /`。
 */
const BASH_TOOL = {
  name: 'Bash',
  description: 'Run a shell command',
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      description: { type: 'string' },
      timeout: { type: 'number' },
    },
    required: ['command'],
  },
};

/** 用 Bash 工具（带 schema）发一次请求；实际载荷由 stubUpstreamContent 决定。 */
function sendWithBashTool() {
  return newAdapter().sendRequest({
    model: 'claude-opus-4.6',
    messages: [{ role: 'user', content: 'run' }],
    max_tokens: 128,
    tools: [BASH_TOOL],
  } as unknown as AnthropicRequest);
}

Deno.test('DeepSeek adapter 还原 echo 内层双引号未转义的工具调用（实测卡死载荷）', async () => {
  const restore = stubUpstreamContent([{
    type: 'text',
    text: String
      .raw`Previous assistant tool request: name=Bash id=call_q1 input_json={"command":"echo "=== cwd ==="; pwd; find /d -name "*.sqlite" | head -5","description":"Diagnose KV file location"}`,
  }]);

  try {
    const response = await sendWithBashTool();
    // 核心：必须改判成 tool_use，否则 Claude Code 认为回合结束而停下
    assertEquals(response.stop_reason, 'tool_use');
    if (response.content[0].type === 'tool_use') {
      assertEquals(
        response.content[0].input.command,
        'echo "=== cwd ==="; pwd; find /d -name "*.sqlite" | head -5',
      );
      assertEquals(response.content[0].input.description, 'Diagnose KV file location');
    }
  } finally {
    restore();
  }
});

Deno.test('DeepSeek adapter 还原 python -c 内层双引号 + 非法转义并存的调用', async () => {
  const restore = stubUpstreamContent([{
    type: 'text',
    text: String
      .raw`Previous assistant tool request: name=Bash id=call_q2 input_json={"command":"TOKEN=$(python -c "import re\nm=re.match(r'A\s*=\s*(.+)', l)") && curl -H "Authorization: Bearer $TOKEN" http://x/stats.json","description":"Trigger cleanup"}`,
  }]);

  try {
    const response = await sendWithBashTool();
    assertEquals(response.stop_reason, 'tool_use');
    if (response.content[0].type === 'tool_use') {
      const command = String(response.content[0].input.command);
      // 内层引号还原
      assertEquals(command.includes('python -c "import re'), true);
      assertEquals(command.includes('curl -H "Authorization: Bearer $TOKEN"'), true);
      // 正则里的 \s 是非法 JSON 转义，必须补成字面反斜杠而不是被吞掉
      assertEquals(command.includes(String.raw`r'A\s*=\s*(.+)'`), true);
    }
  } finally {
    restore();
  }
});

Deno.test('DeepSeek adapter 不因内容里的逗号截断命令（截断比合并危险）', async () => {
  const restore = stubUpstreamContent([{
    type: 'text',
    // 逗号后是 ` b`，不是 `"<合法键>":`，因此不构成字段分隔
    text: String
      .raw`Previous assistant tool request: name=Bash id=call_q3 input_json={"command":"echo "a", b"}`,
  }]);

  try {
    const response = await sendWithBashTool();
    assertEquals(response.stop_reason, 'tool_use');
    if (response.content[0].type === 'tool_use') {
      assertEquals(response.content[0].input.command, 'echo "a", b');
    }
  } finally {
    restore();
  }
});

Deno.test('DeepSeek adapter 只在后继键属于本工具 schema 时才切分字段', async () => {
  // `b` 不是 Bash 的合法参数，`","b":` 因此只是命令内容，不是字段分隔。
  // 注意 `}` 前只有一个引号，单字段读法下值只能到 c 为止——这是唯一自洽解。
  // 关键性质是没有被截断成 `echo "a"`。
  const restore = stubUpstreamContent([{
    type: 'text',
    text: String
      .raw`Previous assistant tool request: name=Bash id=call_q4 input_json={"command":"echo "a","b":"c"}`,
  }]);

  try {
    const response = await sendWithBashTool();
    assertEquals(response.stop_reason, 'tool_use');
    if (response.content[0].type === 'tool_use') {
      assertEquals(response.content[0].input.command, 'echo "a","b":"c');
      assertEquals(response.content[0].input.b, undefined);
    }
  } finally {
    restore();
  }
});

Deno.test('DeepSeek adapter 后继键合法时正常切分（不把后续字段吞进前一个值）', async () => {
  const restore = stubUpstreamContent([{
    type: 'text',
    text: String
      .raw`Previous assistant tool request: name=Bash id=call_q5 input_json={"command":"echo "hi"","description":"say hi"}`,
  }]);

  try {
    const response = await sendWithBashTool();
    assertEquals(response.stop_reason, 'tool_use');
    if (response.content[0].type === 'tool_use') {
      assertEquals(response.content[0].input.command, 'echo "hi"');
      assertEquals(response.content[0].input.description, 'say hi');
    }
  } finally {
    restore();
  }
});

Deno.test('DeepSeek adapter 修复引号时保留非字符串值', async () => {
  const restore = stubUpstreamContent([{
    type: 'text',
    text: String
      .raw`Previous assistant tool request: name=Bash id=call_q6 input_json={"command":"echo "x"","timeout":5000}`,
  }]);

  try {
    const response = await sendWithBashTool();
    assertEquals(response.stop_reason, 'tool_use');
    if (response.content[0].type === 'tool_use') {
      assertEquals(response.content[0].input.command, 'echo "x"');
      assertEquals(response.content[0].input.timeout, 5000);
    }
  } finally {
    restore();
  }
});
