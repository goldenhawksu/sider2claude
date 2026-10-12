import { AnthropicApiAdapter, AnthropicBackendError } from '../src/adapters/anthropic-adapter.ts';
import { parseTextualToolUseLine } from '../src/utils/textual-tool-use.ts';
import {
  runWriteRecoveryCase,
  runWriteStreamRecoveryCase,
  WRITE_RECOVERY_CASES,
} from './fixtures/write-recovery.ts';
import { Hono } from 'hono';

for (const corrected of [true, false]) {
  Deno.test(`Write HTTP/SSE：纠错${corrected ? '成功' : '失败'}的客户端执行边界`, async () => {
    const vars = {
      S2C_DISABLE_DOTENV: 'true',
      AUTH_TOKEN: 'test-token-12345',
      DEEPSEEK_API_KEY: 'test-key',
      DEEPSEEK_BASE_URL: 'https://write.example',
      DEEPSEEK_MODEL: 'glm-5.3-flash',
      DEFAULT_BACKEND: 'deepseek',
      SIDER_AUTH_TOKEN: '',
      SIDER_CONTROLLER: 'false',
    };
    const previous = new Map(Object.keys(vars).map((key) => [key, Deno.env.get(key)]));
    try {
      for (const [key, value] of Object.entries(vars)) Deno.env.set(key, value);
      const { hybridMessagesRouter } = await import(
        `../src/routes/messages-hybrid.ts?write=${crypto.randomUUID()}`
      );
      const app = new Hono();
      app.route('/v1/messages', hybridMessagesRouter);
      await runWriteStreamRecoveryCase((request) =>
        app.request('/v1/messages', {
          method: 'POST',
          headers: { authorization: 'Bearer test-token-12345', 'content-type': 'application/json' },
          body: JSON.stringify(request),
        }), corrected);
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) Deno.env.delete(key);
        else Deno.env.set(key, value);
      }
    }
  });
}

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

for (const sample of WRITE_RECOVERY_CASES) {
  Deno.test(`Write 纠错边界：${sample.name}`, () => runWriteRecoveryCase(adapter(), sample));
}

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

Deno.test('Write：可确定恢复 SVG/XML 裸属性引号、Windows 路径和换行', () => {
  const actual = parseTextualToolUseLine(
    String
      .raw`[tool_use:Write] id=svg_1 input={"file_path":"D:\AI_Coder\slides\01_cover.svg","content":"<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"></svg>"}`,
    KEYS,
  );
  assert(actual?.type === 'tool_use', 'SVG Write 必须恢复为工具调用');
  if (actual?.type === 'tool_use') {
    assert(actual.id === 'svg_1' && actual.name === 'Write', '工具标识必须保持');
    assert(
      actual.input.file_path === String.raw`D:\AI_Coder\slides\01_cover.svg`,
      'Windows 路径必须逐字恢复',
    );
    assert(
      actual.input.content ===
        '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"></svg>',
      'SVG 属性引号和换行必须逐字恢复',
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

Deno.test('Write：多行格式化的严格 JSON 长参数逐字还原', async () => {
  const originalFetch = globalThis.fetch;
  const input = {
    file_path: String.raw`d:\AI_Coder\ppt-master\projects\用户文档\design_spec.md`,
    content: '# 用户说明文档\n\n' +
      '包含 `file_path`、"引号"、中文和反斜杠 C:\\next。\n'.repeat(300),
  };
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
    const response = await adapter().sendRequest({
      model: 'claude-sonnet-5.5',
      tools: [WRITE],
      messages: [{ role: 'user', content: '写设计说明' }],
    });
    const actual = response.content[0];
    assert(actual.type === 'tool_use', '多行严格 JSON 必须还原为工具调用');
    if (actual.type === 'tool_use') {
      assert(actual.input.file_path === input.file_path, '路径必须逐字一致');
      assert(actual.input.content === input.content, '长正文必须逐字一致');
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('Write：显式逐字边界从用户原文恢复路径和正文，不执行模型改写版本', async () => {
  const originalFetch = globalThis.fetch;
  const input = {
    file_path: String.raw`d:\PPT_Test\projects\用户文档\images\image_prompts.json`,
    content: '{\n  "prompt": "保持引号",\n  "items": 12\n}',
  };
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
    const response = await adapter().sendRequest({
      model: 'claude-opus-5.5',
      tools: [WRITE],
      messages: [{
        role: 'user',
        content:
          `只调用一次 Write，将下面内容逐字写入。目标路径：${input.file_path}\n正文开始\n${input.content}\n正文结束`,
      }],
    });
    assert(response.content[0].type === 'tool_use', '必须保留模型选择的Write调用');
    if (response.content[0].type === 'tool_use') {
      assert(response.content[0].input.file_path === input.file_path, '路径取用户明确原文');
      assert(response.content[0].input.content === input.content, '正文取用户明确边界');
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('Write：参数截断或带额外字段时只纠错一次并返回完整结构化调用', async () => {
  const originalFetch = globalThis.fetch;
  const requests: any[] = [];
  const expected = { file_path: 'D:/slides/design.md', content: '# 完整设计说明\n正文' };
  try {
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      const input = requests.length === 1
        ? { file_path: expected.file_path, content: '# 不完整', content_truncated: true }
        : expected;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            content: [{ type: 'tool_use', id: `write_${requests.length}`, name: 'Write', input }],
            stop_reason: 'tool_use',
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      );
    }) as typeof fetch;

    const response = await adapter().sendRequest({
      model: 'claude-sonnet-5.5',
      tools: [WRITE],
      messages: [{ role: 'user', content: '写设计说明' }],
    });
    assert(requests.length === 2, '无效 Write 只能重试一次');
    assert(String(requests[1].system).includes('Write correction:'), '重试必须携带纠错契约');
    assert(
      String(requests[1].messages.at(-1).content).includes('Tool choice requirement:'),
      '重试必须强制选择 Write',
    );
    const actual = response.content[0];
    assert(actual.type === 'tool_use', '重试必须返回结构化 Write');
    if (actual.type === 'tool_use') {
      assert(actual.id === 'write_2' && actual.name === 'Write', '必须采用第二次完整调用');
      assert(
        actual.input.file_path === expected.file_path && actual.input.content === expected.content,
        '重试后的路径和正文必须完整',
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('Write：纠错仍无效时停止重试，非 Write 失败不触发纠错', async () => {
  const originalFetch = globalThis.fetch;
  try {
    let writeCalls = 0;
    globalThis.fetch = (() => {
      writeCalls += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            content: [{
              type: 'tool_use',
              id: `bad_${writeCalls}`,
              name: 'Write',
              input: { file_path: 'D:/slides/design.md', content_truncated: '# 不完整' },
            }],
            stop_reason: 'tool_use',
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      );
    }) as typeof fetch;
    let writeError: unknown;
    try {
      await adapter().sendRequest({
        model: 'claude-sonnet-5.5',
        tools: [WRITE],
        messages: [{ role: 'user', content: '写设计说明' }],
      });
    } catch (error) {
      writeError = error;
    }
    assert(writeError instanceof AnthropicBackendError, '第二次无效 Write 必须明确失败');
    assert(writeCalls === 2, 'Write 纠错失败后不能继续重试');

    let readCalls = 0;
    globalThis.fetch = (() => {
      readCalls += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            content: [{ type: 'text', text: '[tool_use:Read] id=read_1 input={"file_path":' }],
            stop_reason: 'end_turn',
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      );
    }) as typeof fetch;
    const response = await adapter().sendRequest({
      model: 'claude-sonnet-5.5',
      tools: [{
        name: 'Read',
        input_schema: {
          type: 'object',
          properties: { file_path: { type: 'string' } },
          required: ['file_path'],
        },
      }],
      messages: [{ role: 'user', content: '读取文件' }],
    });
    assert(readCalls === 1, '非 Write 失败不得触发纠错重试');
    assert(response.stop_reason === 'end_turn', '非 Write 行为必须保持原样');
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
          type: 'text',
          text:
            'Previous assistant tool request: name=Write id=bad_multiline input_json={\n  "file_path": "correct.json",\n  "content": "正文被截断"',
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
