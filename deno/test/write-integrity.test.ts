import { AnthropicApiAdapter, AnthropicBackendError } from '../src/adapters/anthropic-adapter.ts';
import { parseTextualToolUseLine } from '../src/utils/textual-tool-use.ts';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}
const WRITE = {
  name: 'Write',
  input_schema: {
    type: 'object' as const,
    properties: { file_path: { type: 'string' }, content: { type: 'string' } },
    required: ['file_path', 'content'],
  },
};
const KEYS = new Map([['Write', new Set(['file_path', 'content'])]]);
const adapter = () =>
  new AnthropicApiAdapter({
    enabled: true,
    provider: 'anthropic-compatible',
    baseUrl: 'https://write.example',
    apiKey: 'test-key',
    model: 'glm-5.3-flash',
  });

Deno.test('Write：嵌套 file_path/content 的引号错误不能被猜测修补', () => {
  for (
    const input of [
      String
        .raw`{"file_path":"d:\AI_Coder\correct.json","content":"{"title":"demo","file_path":"d:\wrong-path-test"}"}`,
      String
        .raw`{"file_path":"d:\AI_Coder\correct.json","content":"{"title":"demo","content":"另一份正文"}"}`,
    ]
  ) {
    assert(
      parseTextualToolUseLine(
        'Previous assistant tool request: name=Write id=bad_1 input_json=' + input,
        KEYS,
      ) === undefined,
      '不得还原会改变路径或正文的 Write',
    );
  }
});

Deno.test('Write：结构化和严格文本长参数逐字保留，12 项 manifest 可解析', async () => {
  const originalFetch = globalThis.fetch;
  const input = {
    file_path: String.raw`d:\AI_Coder\ppt-master\projects\用户文档\images\image_prompts.json`,
    content: JSON.stringify(
      {
        items: Array.from(
          { length: 12 },
          (_, index) => ({
            filename: `p${index + 1}.png`,
            file_path: '正文内部的同名字段',
            content: '中文 "引号" 与 C:\\path\\next',
            aspect_ratio: '16:9',
            prompt: '完整提示词。'.repeat(200),
            status: 'Pending',
          }),
        ),
      },
      null,
      2,
    ),
  };
  try {
    for (const textual of [false, true]) {
      const block = textual
        ? { type: 'text', text: `[tool_use:Write] id=good_1 input=${JSON.stringify(input)}` }
        : { type: 'tool_use', id: 'good_1', name: 'Write', input };
      globalThis.fetch = (() =>
        Promise.resolve(
          new Response(JSON.stringify({ content: [block], stop_reason: 'end_turn' }), {
            headers: { 'content-type': 'application/json' },
          }),
        )) as typeof fetch;
      const response = await adapter().sendRequest({
        model: 'claude-opus-5.5',
        tools: [WRITE],
        messages: [{ role: 'user', content: '写 manifest' }],
      });
      const actual = response.content[0];
      assert(actual.type === 'tool_use', '必须是可执行的完整工具调用');
      if (actual.type === 'tool_use') {
        assert(
          actual.input.file_path === input.file_path && actual.input.content === input.content,
          '路径与正文必须逐字一致',
        );
        assert(JSON.parse(actual.input.content).items.length === 12, '12 项 JSON 完整');
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('Write：坏文本和无效结构化参数明确阻止执行，不转成空输入', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (
      const content of [
        [{
          type: 'text',
          text:
            'Previous assistant tool request: name=Write id=bad_1 input_json={"file_path":"correct.json","content":"{"title":"demo","file_path":"wrong.json"}"}',
        }],
        [{
          type: 'tool_use',
          id: 'bad_2',
          name: 'Write',
          input: { file_path: 'correct.json', content: { invalid: true } },
        }],
        [{ type: 'tool_use', id: 'bad_3', name: 'Write', input: [] }],
        [{
          type: 'tool_use',
          id: 'bad_4',
          name: 'Write',
          input: { file_path: 'd:\nnew\file', content: '正文' },
        }],
      ]
    ) {
      globalThis.fetch = (() =>
        Promise.resolve(
          new Response(JSON.stringify({ content, stop_reason: 'tool_use' }), {
            headers: { 'content-type': 'application/json' },
          }),
        )) as typeof fetch;
      let error: unknown;
      try {
        await adapter().sendRequest({
          model: 'claude-opus-5.5',
          tools: [WRITE],
          messages: [{ role: 'user', content: '写入' }],
        });
      } catch (e) {
        error = e;
      }
      assert(
        error instanceof AnthropicBackendError && error.statusCode === 502,
        '无效参数应明确返回上游响应错误',
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
