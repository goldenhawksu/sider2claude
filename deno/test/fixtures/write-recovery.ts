import type {
  AnthropicRequest,
  AnthropicResponse,
  AnthropicToolUse,
} from '../../src/types/anthropic.ts';

const WRITE = {
  name: 'Write',
  input_schema: {
    type: 'object' as const,
    properties: { file_path: { type: 'string' }, content: { type: 'string' } },
    required: ['file_path', 'content'],
  },
};
const BASH = { name: 'Bash', input_schema: { type: 'object' as const, properties: {} } };
const input = { file_path: 'D:/slides/06_runtimes.svg', content: '<svg width="1280">中文</svg>\n' };
const write: AnthropicToolUse = { type: 'tool_use', id: 'write_corrected', name: 'Write', input };
const bare = `Write ${JSON.stringify(input)}`;
const bad = {
  type: 'text',
  text: '[tool_use:Write] id=bad input={"file_path":"D:/slides/06_runtimes.svg","content":',
};
const corruptedPptSpec = {
  type: 'text',
  text: String
    .raw`Previous assistant tool request: name=Write id=bad_ppt_spec input_json={"file_path":"D:\AI_Coder\ppt-master\projects\guide\spec_lock.md","content":"# Execution Lock\n\n## page_charts\n- P16: basic_table
- Mixing icon libraries
- rgba()
- <style>, class, foreignObject Executor re-reads spec_lock.md before every page.
..."}`,
};

interface RecoveryCase {
  name: string;
  first: unknown[];
  second?: unknown[];
  request?: Partial<AnthropicRequest>;
  stopReason?: string;
  error?: boolean;
  retry?: boolean;
  write?: boolean;
  sse?: boolean;
}

// 两个运行时共用故障样例和断言，确保同一输入具有相同结果。
export const WRITE_RECOVERY_CASES: RecoveryCase[] = [
  {
    name: 'PPT spec：转义换行中途退化为原始换行时必须纠错',
    first: [corruptedPptSpec],
    second: [write],
    retry: true,
    write: true,
  },
  {
    name: '附件格式：行内 Write 与 Bash 普通文本只纠正 Write',
    first: [{ type: 'thinking', thinking: '生成 P06' }, {
      type: 'text',
      text: `现在生成 P06。🎯 Layout strategy: 全宽三列表格 ${bare} Bash {"command":"ls slides/"}`,
    }],
    second: [write],
    retry: true,
    write: true,
    sse: true,
  },
  {
    name: '独占一行的 Write 加多行 JSON 可触发纠错',
    first: [{ type: 'text', text: `Write\n${JSON.stringify(input, null, 2)}` }],
    second: [write],
    retry: true,
    write: true,
  },
  {
    name: '裸 Write 加未转义 SVG 引号可触发纠错',
    first: [{
      type: 'text',
      text: 'Write {"file_path":"D:/slides/06.svg","content":"<svg width="1280"></svg>"}',
    }],
    second: [write],
    retry: true,
    write: true,
  },
  {
    name: '重试普通回答不得静默 end_turn',
    first: [bad],
    second: [{ type: 'text', text: '已完成写入。' }],
    retry: true,
    error: true,
  },
  {
    name: '重试文本转录不得冒充原生结构化调用',
    first: [bad],
    second: [{ type: 'text', text: `[tool_use:Write] id=second input=${JSON.stringify(input)}` }],
    retry: true,
    error: true,
  },
  {
    name: '重试不得执行其他工具',
    first: [bad],
    second: [{ type: 'tool_use', id: 'bash_1', name: 'Bash', input: { command: 'ls' } }],
    retry: true,
    error: true,
  },
  {
    name: '重试多个 Write 必须阻断',
    first: [bad],
    second: [write, { ...write, id: 'write_2' }],
    retry: true,
    error: true,
  },
  {
    name: '重试不能复用已执行的工具标识',
    first: [bad],
    second: [write],
    retry: true,
    error: true,
    request: {
      messages: [{ role: 'assistant', content: [write] }, {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: write.id, content: '成功' }],
      }],
    },
  },
  {
    name: '真实客户端 Write schema 约束在重试时继续生效',
    first: [bad],
    second: [write],
    retry: true,
    error: true,
    request: {
      tools: [{
        ...WRITE,
        input_schema: {
          ...WRITE.input_schema,
          properties: {
            ...WRITE.input_schema.properties,
            file_path: { const: 'D:/slides/other.svg' },
          },
        },
      }],
    },
  },
  {
    name: '没有声明 Write 不启动纠错',
    first: [{ type: 'text', text: bare }],
    request: { tools: [BASH] },
  },
  {
    name: 'tool_choice none 不启动纠错',
    first: [{ type: 'text', text: bare }],
    request: { tool_choice: { type: 'none' } },
  },
  {
    name: '强制其他工具时不启动 Write 纠错',
    first: [{ type: 'text', text: bare }],
    request: { tool_choice: { type: 'tool', name: 'Bash' } },
  },
  {
    name: '代码示例不启动纠错',
    first: [{ type: 'text', text: `用法示例：\n\`\`\`json\n${bare}\n\`\`\`` }],
  },
  { name: '行内代码示例不启动纠错', first: [{ type: 'text', text: `工具格式为 \`${bare}\`。` }] },
  {
    name: 'JSON 字符串里的 Write 示例不启动纠错',
    first: [{ type: 'text', text: JSON.stringify({ example: bare }) }],
  },
  {
    name: '双引号引用的 Write 示例不启动纠错',
    first: [{ type: 'text', text: `示例为 "${bare}"。` }],
  },
  {
    name: '已结构化 Write 正文含 Write 示例不重复纠错',
    first: [{ ...write, input: { ...input, content: bare } }],
    write: true,
  },
  {
    name: '已结构化 Write 旁边的文本说明不重复纠错',
    first: [write, { type: 'text', text: bare }],
    write: true,
  },
  {
    name: '服务端工具结果中的 Write 示例不启动纠错',
    first: [{ type: 'tool_result', tool_use_id: 'server_1', content: bare }],
  },
  {
    name: '含服务端执行记录的无效 Write 不重放上游请求',
    first: [{ type: 'server_tool_use', id: 'server_1', name: 'web_fetch', input: {} }, bad],
    error: true,
  },
];

export async function runWriteRecoveryCase(
  adapter: { sendRequest(request: AnthropicRequest): Promise<AnthropicResponse> },
  sample: RecoveryCase,
) {
  const originalFetch = globalThis.fetch;
  const calls: AnthropicRequest[] = [];
  const check = (condition: boolean, message: string) => {
    if (!condition) throw new Error(`${sample.name}：${message}`);
  };
  try {
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      const content = calls.length === 1 ? sample.first : sample.second ?? sample.first;
      const stop_reason = calls.length === 1 ? sample.stopReason ?? 'end_turn' : 'tool_use';
      const message = { content, stop_reason, usage: { input_tokens: 85, output_tokens: 17 } };
      if (!sample.sse) {
        return Promise.resolve(
          new Response(JSON.stringify(message), {
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      const events = [
        { type: 'message_start', message: { ...message, content: [] } },
        ...content.flatMap((block, index) => [
          { type: 'content_block_start', index, content_block: block },
          { type: 'content_block_stop', index },
        ]),
        { type: 'message_delta', delta: { stop_reason }, usage: { output_tokens: 17 } },
        { type: 'message_stop' },
      ];
      return Promise.resolve(
        new Response(
          events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      );
    }) as typeof fetch;
    let response: AnthropicResponse | undefined;
    let error: unknown;
    try {
      response = await adapter.sendRequest({
        model: 'claude-sonnet-5.5',
        tools: [WRITE, BASH],
        messages: [{ role: 'user', content: '生成 P06 并写入文件' }],
        ...sample.request,
      });
    } catch (caught) {
      error = caught;
    }
    check(calls.length === (sample.retry ? 2 : 1), `上游请求数为 ${calls.length}`);
    check(Boolean(error) === Boolean(sample.error), `错误状态不符：${String(error)}`);
    if (sample.error) {
      check(
        error instanceof Error && 'statusCode' in error && error.statusCode === 502,
        '必须返回可识别的 502 后端错误',
      );
    }
    if (sample.write) {
      check(
        response?.content.some((block) => block.type === 'tool_use' && block.name === 'Write') ===
          true,
        '必须返回可执行 Write',
      );
      check(response?.stop_reason === 'tool_use', '结束原因必须为 tool_use');
    }
    if (sample.retry) {
      check(
        calls[1].tools?.length === 1 && calls[1].tools[0].name === 'Write',
        '纠错仅向上游提供 Write',
      );
      check(
        calls[1].messages.length > (sample.request?.messages?.length ?? 1),
        '纠错需要携带失败响应上下文',
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
}

/** 验证客户端真正收到的合成 SSE，工具输入只有纠错成功后才可下发。 */
export async function runWriteStreamRecoveryCase(
  post: (request: AnthropicRequest) => Response | Promise<Response>,
  corrected: boolean,
) {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = (() => {
      calls += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            content: calls === 1
              ? [{ type: 'text', text: bare }]
              : corrected
              ? [write]
              : [{ type: 'text', text: '已完成。' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 85, output_tokens: 17 },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      );
    }) as typeof fetch;
    const response = await post({
      model: 'claude-sonnet-5.5',
      max_tokens: 8192,
      stream: true,
      messages: Array.from({ length: 85 }, (_, index) => ({
        role: index % 2 ? 'assistant' : 'user',
        content: `生成 P06 写入文件 ${index}`,
      })),
      tools: [
        WRITE,
        BASH,
        ...Array.from({ length: 15 }, (_, index) => ({
          name: `Tool_${index}`,
          input_schema: { type: 'object' as const, properties: {} },
        })),
      ],
    });
    if (!corrected && response.status === 502) {
      const body = await response.json();
      if (calls !== 2 || !body.error) throw new Error('纠错失败必须返回明确的 API 错误');
      return;
    }
    if (response.status !== 200) throw new Error(`流式 HTTP 状态异常：${response.status}`);
    const events = (await response.text()).split(/\r?\n/).filter((line) => line.startsWith('data:'))
      .map((line) => JSON.parse(line.slice(5).trim()));
    const toolEvents = events.filter((event) =>
      event.type === 'content_block_start' && event.content_block?.type === 'tool_use'
    );
    const errors = events.filter((event) => event.type === 'error');
    if (calls !== 2) throw new Error(`只允许请求上游两次，实际 ${calls} 次`);
    if (corrected) {
      if (
        toolEvents.length !== 1 || toolEvents[0].content_block.name !== 'Write' || errors.length
      ) {
        throw new Error('纠错成功必须下发且仅下发一个 Write');
      }
      const argument = events.filter((event) => event.type === 'content_block_delta')
        .map((event) => event.delta?.partial_json ?? '').join('');
      if (JSON.stringify(JSON.parse(argument)) !== JSON.stringify(input)) {
        throw new Error('SSE 正文参数被改变');
      }
      if (
        !events.some((event) =>
          event.type === 'message_delta' && event.delta?.stop_reason === 'tool_use'
        ) || events.at(-1)?.type !== 'message_stop'
      ) {
        throw new Error('纠错成功必须以 tool_use 结束并关闭消息');
      }
    } else if (
      toolEvents.length || errors.length !== 1 ||
      events.some((event) =>
        event.type === 'message_delta' && event.delta?.stop_reason === 'end_turn'
      )
    ) {
      throw new Error('纠错失败必须返回流内 error，不能下发 Write 或静默 end_turn');
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
}
