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

    // 提示词必须挂在 system 上：挂最后一条 user 消息尾部时，同一条消息在下一轮
    // 不再带这段后缀，上游 prefix 缓存必然在那里断掉（实测命中率 81%→90%）。
    const systemContent = String(calls[0].body.system);
    expect(systemContent).toContain('Tool protocol:');
    expect(systemContent).toContain('[tool_use:Name]');
    expect(calls[0].body.messages[0].content as string).not.toContain('Tool protocol:');
  });

  test('无工具时不注入提示词', async () => {
    const calls = stubUpstreamContent([{ type: 'text', text: 'ok' }]);

    await newAdapter().sendRequest({
      model: 'claude-opus-4.6',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 128,
    } as unknown as AnthropicRequest);

    expect(calls[0].body.system).toBeUndefined();
    const userContent = calls[0].body.messages[0].content;
    expect(userContent as string).not.toContain('Tool protocol:');
  });

  test('多轮之间发往上游的请求前缀逐字节稳定（缓存命中的前提）', async () => {
    const calls = stubUpstreamContent([{ type: 'text', text: 'ok' }]);
    const adapter = newAdapter();

    const history = (turn: number) => {
      const messages: AnthropicRequest['messages'] = [
        { role: 'user', content: 'start the audit' },
      ];
      for (let i = 0; i < turn; i += 1) {
        messages.push({
          role: 'assistant',
          content: [
            { type: 'tool_use', id: `toolu_${i}`, name: 'Read', input: { file_path: `f${i}.ts` } },
          ],
        });
        messages.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: `toolu_${i}`, content: `body ${i}` }],
        });
      }
      return messages;
    };

    for (let turn = 0; turn <= 2; turn += 1) {
      await adapter.sendRequest({
        model: 'claude-opus-4.6',
        system: 'You are Claude Code.',
        messages: history(turn),
        max_tokens: 128,
        tools: [READ_TOOL],
      } as unknown as AnthropicRequest);
    }

    for (let i = 1; i < calls.length; i += 1) {
      const earlier = calls[i - 1].body;
      const later = calls[i].body;
      expect(JSON.stringify(later.system)).toBe(JSON.stringify(earlier.system));
      expect(JSON.stringify(later.tools)).toBe(JSON.stringify(earlier.tools));
      for (let m = 0; m < earlier.messages.length; m += 1) {
        expect(JSON.stringify(later.messages[m])).toBe(JSON.stringify(earlier.messages[m]));
      }
    }
  });

  test('上游 usage 的缓存字段透传，不在归一化时被砍掉', async () => {
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as AnthropicRequest;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: 'msg_cache',
            type: 'message',
            role: 'assistant',
            model: body.model,
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              cache_creation_input_tokens: 128,
              cache_read_input_tokens: 4480,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    }) as typeof fetch;

    const response = await newAdapter().sendRequest({
      model: 'claude-opus-4.6',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 128,
    } as unknown as AnthropicRequest);

    expect(response.usage.cache_read_input_tokens).toBe(4480);
    expect(response.usage.cache_creation_input_tokens).toBe(128);
  });

  test('tool_choice：auto/any 原生透传；none 摘掉 tools 兑现语义；强制指定工具改注入文本', async () => {
    for (const choice of [{ type: 'auto' }, { type: 'any' }] as const) {
      const calls = stubUpstreamContent([{ type: 'text', text: 'ok' }]);
      await newAdapter().sendRequest({
        model: 'claude-opus-4.6',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 128,
        tools: [READ_TOOL],
        tool_choice: choice,
      } as unknown as AnthropicRequest);

      expect(JSON.stringify(calls[0].body.tool_choice)).toBe(JSON.stringify(choice));
      expect(calls[0].body.tools).toBeDefined();
      const userContent = calls[0].body.messages[0].content as string;
      expect(userContent).not.toContain('Tool choice requirement');
      // 回归：type:'none' 曾经掉进"强制某个工具"分支，注入 `named "undefined"`。
      expect(userContent).not.toContain('undefined');
    }

    // none：probe 实测上游完全忽略 tool_choice（见 deno/tools/probe-deepseek-tool-choice.ts），
    // 透传等于让它静默失效。改为摘掉 tools——工具不可见才是唯一可靠的做法。
    {
      const calls = stubUpstreamContent([{ type: 'text', text: 'ok' }]);
      await newAdapter().sendRequest({
        model: 'claude-opus-4.6',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 128,
        tools: [READ_TOOL],
        tool_choice: { type: 'none' },
      } as unknown as AnthropicRequest);

      expect(calls[0].body.tools).toBeUndefined();
      expect(calls[0].body.tool_choice).toBeUndefined();
      const userContent = calls[0].body.messages[0].content as string;
      expect(userContent).not.toContain('Tool choice requirement');
      expect(userContent).not.toContain('undefined');
    }

    const calls = stubUpstreamContent([{ type: 'text', text: 'ok' }]);
    await newAdapter().sendRequest({
      model: 'claude-opus-4.6',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 128,
      tools: [READ_TOOL],
      tool_choice: { type: 'tool', name: 'Read' },
    } as unknown as AnthropicRequest);

    expect(calls[0].body.tool_choice).toBeUndefined();
    expect(calls[0].body.messages[0].content as string)
      .toContain('Tool choice requirement: call the tool named "Read"');
  });

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

  const sendWithBashTool = () =>
    newAdapter().sendRequest({
      model: 'claude-opus-4.6',
      messages: [{ role: 'user', content: 'run' }],
      max_tokens: 128,
      tools: [BASH_TOOL],
    } as unknown as AnthropicRequest);

  // 实测卡死载荷：命令里带引号是 Bash 调用的常态，模型模仿转录时不会转义，
  // 解析失败就会退化成 end_turn，Claude Code 据此结束回合、要人说"请继续"。
  test('还原内层双引号未转义的工具调用（实测卡死载荷）', async () => {
    stubUpstreamContent([{
      type: 'text',
      text: String
        .raw`Previous assistant tool request: name=Bash id=call_q1 input_json={"command":"echo "=== cwd ==="; pwd; find /d -name "*.sqlite" | head -5","description":"Diagnose KV file location"}`,
    }]);

    const response = await sendWithBashTool();
    expect(response.stop_reason).toBe('tool_use');
    expect(response.content[0]).toMatchObject({
      type: 'tool_use',
      name: 'Bash',
      input: {
        command: 'echo "=== cwd ==="; pwd; find /d -name "*.sqlite" | head -5',
        description: 'Diagnose KV file location',
      },
    });
  });

  // 截断比合并危险得多：赌错方向能把 rm -rf /tmp/x 截成 rm -rf /
  test('内容里的逗号不构成字段分隔，命令不得被截断', async () => {
    stubUpstreamContent([{
      type: 'text',
      text: String.raw`Previous assistant tool request: name=Bash id=call_q3 input_json={"command":"echo "a", b"}`,
    }]);

    const response = await sendWithBashTool();
    expect(response.stop_reason).toBe('tool_use');
    expect(response.content[0]).toMatchObject({
      type: 'tool_use',
      input: { command: 'echo "a", b' },
    });
  });

  test('后继键属于本工具 schema 时才切分字段', async () => {
    stubUpstreamContent([{
      type: 'text',
      text: String
        .raw`Previous assistant tool request: name=Bash id=call_q5 input_json={"command":"echo "hi"","description":"say hi"}`,
    }]);

    const response = await sendWithBashTool();
    expect(response.stop_reason).toBe('tool_use');
    expect(response.content[0]).toMatchObject({
      type: 'tool_use',
      input: { command: 'echo "hi"', description: 'say hi' },
    });
  });
});
