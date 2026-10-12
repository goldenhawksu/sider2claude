import { expect, test } from 'bun:test';
import { parseTextualToolUseLine } from '../src/utils/textual-tool-use';
import { AnthropicApiAdapter, AnthropicBackendError } from '../src/adapters/anthropic-adapter';

const WRITE = {
  name: 'Write',
  input_schema: {
    type: 'object' as const,
    properties: { file_path: { type: 'string' }, content: { type: 'string' } },
    required: ['file_path', 'content'],
  },
};
const KEYS = new Map([['Write', new Set(['file_path', 'content'])]]);

test('Write 非严格 JSON 中的嵌套字段不得覆盖路径或截断正文', () => {
  for (
    const input of [
      String
        .raw`{"file_path":"d:\AI_Coder\correct.json","content":"{"title":"demo","file_path":"d:\wrong-path-test"}"}`,
      String
        .raw`{"file_path":"d:\AI_Coder\correct.json","content":"{"title":"demo","content":"另一份正文"}"}`,
    ]
  ) {
    expect(
      parseTextualToolUseLine(
        'Previous assistant tool request: name=Write id=bad_1 input_json=' + input,
        KEYS,
      ),
    ).toBeUndefined();
  }
});

test('合法长 Write 的路径和正文完全保留，包括同名字段、引号、反斜杠、中文和换行', async () => {
  const originalFetch = globalThis.fetch;
  const file_path = String.raw`d:\AI_Coder\ppt-master\projects\用户文档\images\image_prompts.json`;
  const content = JSON.stringify(
    {
      items: Array.from({ length: 12 }, (_, index) => ({
        filename: `p${index + 1}.png`,
        file_path: '这是正文内部字段，不是工具路径',
        content: '正文 "引用" 和 C:\\next\\file',
        aspect_ratio: '16:9',
        prompt: '完整提示词。'.repeat(200),
        status: 'Pending',
      })),
    },
    null,
    2,
  );
  const input = { file_path, content };
  const adapter = new AnthropicApiAdapter({
    enabled: true,
    provider: 'anthropic-compatible',
    baseUrl: 'https://write.example',
    apiKey: 'test-key',
    model: 'glm-5.3-flash',
  });
  try {
    for (const textual of [false, true]) {
      const block = textual
        ? {
          type: 'text',
          text: `Previous assistant tool request: name=Write id=good_1 input_json=${
            JSON.stringify(input)
          }`,
        }
        : { type: 'tool_use', id: 'good_1', name: 'Write', input };
      globalThis.fetch = (() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              content: [block],
              stop_reason: 'end_turn',
              usage: { input_tokens: 10, output_tokens: 100 },
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
        )) as typeof fetch;
      const response = await adapter.sendRequest({
        model: 'claude-opus-5.5',
        max_tokens: 8192,
        tools: [WRITE],
        messages: [{ role: 'user', content: '写入 manifest' }],
      });
      expect(response.content[0]).toEqual({ type: 'tool_use', id: 'good_1', name: 'Write', input });
      expect(response.stop_reason).toBe('tool_use');
      if (response.content[0].type === 'tool_use') {
        expect(JSON.parse(response.content[0].input.content).items).toHaveLength(12);
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('多行格式化的严格 JSON 长 Write 逐字还原', async () => {
  const originalFetch = globalThis.fetch;
  const input = {
    file_path: String.raw`d:\AI_Coder\ppt-master\projects\用户文档\design_spec.md`,
    content: '# 用户说明文档\n\n' +
      '包含 `file_path`、"引号"、中文和反斜杠 C:\\next。\n'.repeat(300),
  };
  const adapter = new AnthropicApiAdapter({
    enabled: true,
    provider: 'anthropic-compatible',
    baseUrl: 'https://write.example',
    apiKey: 'test-key',
    model: 'glm-5.3-flash',
  });
  try {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            content: [{
              type: 'text',
              text: `Previous assistant tool request: name=Write id=pretty_1 input_json=${
                JSON.stringify(input, null, 2)
              }`,
            }],
            stop_reason: 'end_turn',
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      )) as typeof fetch;
    const response = await adapter.sendRequest({
      model: 'claude-sonnet-5.5',
      tools: [WRITE],
      messages: [{ role: 'user', content: '写设计说明' }],
    });
    expect(response.content[0]).toEqual({
      type: 'tool_use',
      id: 'pretty_1',
      name: 'Write',
      input,
    });
    expect(response.stop_reason).toBe('tool_use');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('显式逐字边界从用户原文恢复Write路径和正文', async () => {
  const originalFetch = globalThis.fetch;
  const input = {
    file_path: String.raw`d:\PPT_Test\projects\用户文档\images\image_prompts.json`,
    content: '{\n  "prompt": "保持引号",\n  "items": 12\n}',
  };
  const adapter = new AnthropicApiAdapter({
    enabled: true,
    provider: 'anthropic-compatible',
    baseUrl: 'https://write.example',
    apiKey: 'test-key',
    model: 'glm-5.3-flash',
  });
  try {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            content: [{
              type: 'tool_use',
              id: 'exact_write_1',
              name: 'Write',
              input: {
                file_path: 'd:\\wrong\\output.json',
                content: '{\n  "prompt": "保持引号", broken\n}',
              },
            }],
            stop_reason: 'tool_use',
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      )) as typeof fetch;
    const response = await adapter.sendRequest({
      model: 'claude-opus-5.5',
      tools: [WRITE],
      messages: [{
        role: 'user',
        content:
          `只调用一次 Write，将下面内容逐字写入。目标路径：${input.file_path}\n正文开始\n${input.content}\n正文结束`,
      }],
    });
    expect(response.content[0]).toEqual({
      type: 'tool_use',
      id: 'exact_write_1',
      name: 'Write',
      input,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('坏 Write 阻止整轮工具执行，不能先执行同轮其他调用', async () => {
  const originalFetch = globalThis.fetch;
  const adapter = new AnthropicApiAdapter({
    enabled: true,
    provider: 'anthropic-compatible',
    baseUrl: 'https://write.example',
    apiKey: 'test-key',
    model: 'glm-5.3-flash',
  });
  try {
    for (
      const content of [
        [{
          type: 'text',
          text:
            '[tool_use:Read] id=read_1 input={"file_path":"a.md"}\nPrevious assistant tool request: name=Write id=bad_2 input_json={"file_path":"correct.json","content":"{"title":"demo","file_path":"wrong.json"}"}',
        }],
        [{
          type: 'text',
          text:
            'Previous assistant tool request: name=Write id=bad_multiline input_json={\n  "file_path": "correct.json",\n  "content": "正文被截断"',
        }],
        [{
          type: 'tool_use',
          id: 'bad_native',
          name: 'Write',
          input: { file_path: 'correct.json', content: { invalid: '不是字符串' } },
        }],
        [{ type: 'tool_use', id: 'bad_native', name: 'Write', input: { content: '缺少路径' } }],
      ]
    ) {
      globalThis.fetch = (() =>
        Promise.resolve(
          new Response(JSON.stringify({ content, stop_reason: 'tool_use' }), {
            headers: { 'content-type': 'application/json' },
          }),
        )) as typeof fetch;
      await expect(
        adapter.sendRequest({
          model: 'claude-opus-5.5',
          tools: [WRITE],
          messages: [{ role: 'user', content: '写入' }],
        }),
      ).rejects.toBeInstanceOf(AnthropicBackendError);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
