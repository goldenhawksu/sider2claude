/**
 * Node/Bun 侧 DeepSeek 适配器单元测试（不需要起服务，mock fetch）。
 *
 * 与 deno/test/deepseek-adapter.test.ts 对应：CLAUDE.md 要求双运行时核心逻辑同步，
 * 文本工具调用兜底是路由/适配器关键路径，两侧都必须覆盖。
 */

import { describe, expect, test, afterEach } from 'bun:test';
import { AnthropicApiAdapter } from '../src/adapters/anthropic-adapter';
import type { AnthropicRequest } from '../src/types/anthropic';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubUpstreamContent(content: unknown[], stopReason: string | null = 'end_turn') {
  const calls: { body: AnthropicRequest }[] = [];
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as AnthropicRequest;
    calls.push({ body });
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
  return calls;
}

function newAdapter() {
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

describe('DeepSeek adapter 文本工具调用兜底', () => {
  test('还原 [tool_use:Name] 转录（Node 侧 sanitize 产出的格式）', async () => {
    stubUpstreamContent([{
      type: 'text',
      text: '我需要读文件。\n[tool_use:Read] id=call_read_1 input={"file_path":"a.ts","limit":60}',
    }]);

    const response = await newAdapter().sendRequest({
      model: 'claude-opus-4.6',
      messages: [{ role: 'user', content: 'review a.ts' }],
      max_tokens: 128,
      tools: [READ_TOOL],
    } as unknown as AnthropicRequest);

    expect(response.stop_reason).toBe('tool_use');
    expect(response.content).toHaveLength(2);
    expect(response.content[0].type).toBe('text');
    expect(response.content[1]).toMatchObject({
      type: 'tool_use',
      name: 'Read',
      id: 'call_read_1',
      input: { file_path: 'a.ts', limit: 60 },
    });
  });

  test('还原 Previous-assistant-tool-request 转录（Deno 侧格式，跨运行时兼容）', async () => {
    stubUpstreamContent([{
      type: 'text',
      text:
        'Previous assistant tool request: name=Bash id=call_01_6I0z input_json={"command":"grep -n x a.ts"}',
    }]);

    const response = await newAdapter().sendRequest({
      model: 'claude-opus-4.6',
      messages: [{ role: 'user', content: 'grep' }],
      max_tokens: 128,
      tools: [READ_TOOL],
    } as unknown as AnthropicRequest);

    expect(response.stop_reason).toBe('tool_use');
    expect(response.content[0]).toMatchObject({
      type: 'tool_use',
      name: 'Bash',
      input: { command: 'grep -n x a.ts' },
    });
  });

  test('复述历史 id 不还原，避免重复执行写操作', async () => {
    stubUpstreamContent([{
      type: 'text',
      text:
        '回顾：\n[tool_use:Bash] id=toolu_history_1 input={"command":"rm -rf build"}',
    }]);

    const response = await newAdapter().sendRequest({
      model: 'claude-opus-4.6',
      messages: [{
        role: 'assistant',
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
      tools: [READ_TOOL],
    } as unknown as AnthropicRequest);

    expect(response.stop_reason).toBe('end_turn');
    expect(response.content).toHaveLength(1);
    expect(response.content[0].type).toBe('text');
  });

  test('还原含未转义 Windows 路径的转录（生产 log 原文）', async () => {
    stubUpstreamContent([{
      type: 'text',
      text: String.raw`Previous assistant tool request: name=Grep id=call_00_GfLr3D3R input_json={"-n":true,"path":"d:\Github_repo\sider2api\deno_pro.ts","pattern":"stats.json"}`,
    }]);

    const response = await newAdapter().sendRequest({
      model: 'claude-opus-4.6',
      messages: [{ role: 'user', content: 'find' }],
      max_tokens: 128,
      tools: [READ_TOOL],
    } as unknown as AnthropicRequest);

    expect(response.stop_reason).toBe('tool_use');
    expect(response.content[0]).toMatchObject({
      type: 'tool_use',
      name: 'Grep',
      input: { '-n': true, path: 'd:\\Github_repo\\sider2api\\deno_pro.ts' },
    });
  });

  test('修补反斜杠时不破坏非路径字符串里的合法转义', async () => {
    stubUpstreamContent([{
      type: 'text',
      text: String.raw`Previous assistant tool request: name=Bash id=call_esc input_json={"command":"echo \"hi\"\nls","path":"C:\ref\bin\x.ts"}`,
    }]);

    const response = await newAdapter().sendRequest({
      model: 'claude-opus-4.6',
      messages: [{ role: 'user', content: 'run' }],
      max_tokens: 128,
      tools: [READ_TOOL],
    } as unknown as AnthropicRequest);

    expect(response.stop_reason).toBe('tool_use');
    expect(response.content[0]).toMatchObject({
      type: 'tool_use',
      input: { command: 'echo "hi"\nls', path: 'C:\\ref\\bin\\x.ts' },
    });
  });

  test('真正无法解析的 input_json 保持文本，不伪造工具调用', async () => {
    stubUpstreamContent([{
      type: 'text',
      text: 'Previous assistant tool request: name=Read id=call_broken input_json={"file_path":"a.ts",',
    }]);

    const response = await newAdapter().sendRequest({
      model: 'claude-opus-4.6',
      messages: [{ role: 'user', content: 'x' }],
      max_tokens: 128,
      tools: [READ_TOOL],
    } as unknown as AnthropicRequest);

    expect(response.stop_reason).toBe('end_turn');
    expect(response.content).toHaveLength(1);
    expect(response.content[0].type).toBe('text');
  });

  test('普通句子不被误判为工具调用', async () => {
    stubUpstreamContent([{
      type: 'text',
      text: '这里解释一下 Previous assistant tool request 这个转录格式的来历。',
    }]);

    const response = await newAdapter().sendRequest({
      model: 'claude-opus-4.6',
      messages: [{ role: 'user', content: 'explain' }],
      max_tokens: 128,
      tools: [READ_TOOL],
    } as unknown as AnthropicRequest);

    expect(response.stop_reason).toBe('end_turn');
    expect(response.content).toHaveLength(1);
    expect(response.content[0].type).toBe('text');
  });

  test('结构化 tool_use 存在时不触发文本兜底', async () => {
    stubUpstreamContent([{
      type: 'text',
      text: '[tool_use:Read] id=call_x input={"file_path":"a.ts"}',
    }, {
      type: 'tool_use',
      id: 'toolu_real',
      name: 'Read',
      input: { file_path: 'b.ts' },
    }]);

    const response = await newAdapter().sendRequest({
      model: 'claude-opus-4.6',
      messages: [{ role: 'user', content: 'go' }],
      max_tokens: 128,
      tools: [READ_TOOL],
    } as unknown as AnthropicRequest);

    expect(response.stop_reason).toBe('tool_use');
    expect(response.content).toHaveLength(2);
    expect(response.content[0].type).toBe('text');
    expect(response.content[1]).toMatchObject({ type: 'tool_use', id: 'toolu_real' });
  });

  test('有工具时注入防模仿提示词，点名实际在用的转录格式', async () => {
    const calls = stubUpstreamContent([{ type: 'text', text: 'ok' }]);

    await newAdapter().sendRequest({
      model: 'claude-opus-4.6',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 128,
      tools: [READ_TOOL],
    } as unknown as AnthropicRequest);

    const userContent = calls[0].body.messages[0].content;
    expect(typeof userContent).toBe('string');
    expect(userContent as string).toContain('Tool protocol:');
    expect(userContent as string).toContain('[tool_use:Name]');
  });

  test('无工具时不注入提示词', async () => {
    const calls = stubUpstreamContent([{ type: 'text', text: 'ok' }]);

    await newAdapter().sendRequest({
      model: 'claude-opus-4.6',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 128,
    } as unknown as AnthropicRequest);

    const userContent = calls[0].body.messages[0].content;
    expect(userContent as string).not.toContain('Tool protocol:');
  });
});
