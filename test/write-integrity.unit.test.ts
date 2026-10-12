import { expect, test } from 'bun:test';
import { parseTextualToolUseLine } from '../src/utils/textual-tool-use';
import { AnthropicApiAdapter, AnthropicBackendError } from '../src/adapters/anthropic-adapter';
import {
  runWriteRecoveryCase,
  runWriteStreamRecoveryCase,
  WRITE_RECOVERY_CASES,
} from '../deno/test/fixtures/write-recovery.ts';
import { Hono } from 'hono';

for (const corrected of [true, false]) {
  test(`Write HTTP/SSE：纠错${corrected ? '成功' : '失败'}的客户端执行边界`, async () => {
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
    const previous = new Map(Object.keys(vars).map((key) => [key, process.env[key]]));
    try {
      Object.assign(process.env, vars);
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
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
}

for (const sample of WRITE_RECOVERY_CASES) {
  test(`Write 纠错边界：${sample.name}`, () =>
    runWriteRecoveryCase(
      new AnthropicApiAdapter({
        enabled: true,
        provider: 'anthropic-compatible',
        baseUrl: 'https://write.example',
        apiKey: 'test-key',
        model: 'glm-5.3-flash',
      }),
      sample,
    ));
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

test('Write 可确定恢复 SVG/XML 裸属性引号、Windows 路径和换行', () => {
  const actual = parseTextualToolUseLine(
    String
      .raw`[tool_use:Write] id=svg_1 input={"file_path":"D:\AI_Coder\slides\01_cover.svg","content":"<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"></svg>"}`,
    KEYS,
  );
  expect(actual).toEqual({
    type: 'tool_use',
    id: 'svg_1',
    name: 'Write',
    input: {
      file_path: String.raw`D:\AI_Coder\slides\01_cover.svg`,
      content:
        '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"></svg>',
    },
  });
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

test('Write 参数截断或带额外字段时只纠错一次并返回完整结构化调用', async () => {
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

    const response = await new AnthropicApiAdapter({
      enabled: true,
      provider: 'anthropic-compatible',
      baseUrl: 'https://write.example',
      apiKey: 'test-key',
      model: 'glm-5.3-flash',
    }).sendRequest({
      model: 'claude-sonnet-5.5',
      tools: [WRITE],
      messages: [{ role: 'user', content: '写设计说明' }],
    });

    expect(requests).toHaveLength(2);
    expect(String(requests[1].system)).toContain('Write correction:');
    expect(String(requests[1].messages.at(-1).content)).toContain('Tool choice requirement:');
    expect(response.content[0]).toEqual({
      type: 'tool_use',
      id: 'write_2',
      name: 'Write',
      input: expected,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Write 纠错仍无效时停止重试，非 Write 失败不触发纠错', async () => {
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
    await expect(
      new AnthropicApiAdapter({
        enabled: true,
        provider: 'anthropic-compatible',
        baseUrl: 'https://write.example',
        apiKey: 'test-key',
        model: 'glm-5.3-flash',
      }).sendRequest({
        model: 'claude-sonnet-5.5',
        tools: [WRITE],
        messages: [{ role: 'user', content: '写设计说明' }],
      }),
    ).rejects.toBeInstanceOf(AnthropicBackendError);
    expect(writeCalls).toBe(2);

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
    const response = await new AnthropicApiAdapter({
      enabled: true,
      provider: 'anthropic-compatible',
      baseUrl: 'https://write.example',
      apiKey: 'test-key',
      model: 'glm-5.3-flash',
    }).sendRequest({
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
    expect(readCalls).toBe(1);
    expect(response.stop_reason).toBe('end_turn');
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
