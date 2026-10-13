import type {
  AnthropicRequest,
  AnthropicResponse,
  AnthropicToolUse,
} from '../../src/types/anthropic.ts';

export const BASH_TOOL = {
  name: 'Bash',
  input_schema: {
    type: 'object' as const,
    properties: {
      command: { type: 'string' },
      description: { type: 'string' },
      timeout: { type: 'number' },
      run_in_background: { type: 'boolean' },
    },
    required: ['command'],
    additionalProperties: false,
  },
};
const WRITE_TOOL = {
  name: 'Write',
  input_schema: {
    type: 'object' as const,
    properties: { file_path: { type: 'string' }, content: { type: 'string' } },
    required: ['file_path', 'content'],
  },
};
const input = {
  command: 'python skills/ppt-master/scripts/svg_quality_checker.py projects/user_guide',
  description: 'SVG 质量检查',
};
const bash: AnthropicToolUse = { type: 'tool_use', id: 'bash_corrected', name: 'Bash', input };
const bare = `Bash\n${JSON.stringify(input)}`;
const text = (value: string) => ({ type: 'text', text: value });

interface BashCase {
  name: string;
  first?: unknown[];
  second?: unknown[];
  request?: Partial<AnthropicRequest>;
  expectedInput?: Record<string, unknown>;
  restored?: boolean;
  error?: boolean;
  noTool?: boolean;
}

export const BASH_RECOVERY_CASES: BashCase[] = [
  { name: '完整 Bash 直接装配且不再次生成参数', restored: true },
  {
    name: '失败 tool_result 后允许重新尝试原命令',
    restored: true,
    request: {
      messages: [{ role: 'assistant', content: [bash] }, {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: bash.id,
          is_error: true,
          content: 'temporary failure',
        }],
      }],
    },
  },
  {
    name: '重复 command 字段不能被覆盖后执行',
    first: [text('Bash {"command":"echo one","command":"echo two"}')],
    error: true,
  },
  {
    name: '转义后的同名 command 字段也必须阻断',
    first: [text(String.raw`Bash {"command":"echo one","\u0063ommand":"echo two"}`)],
    error: true,
  },
  { name: '普通文字示例不是执行意图', first: [text(`示例：${bare}`)], noTool: true },
  { name: '回顾历史不是新的执行意图', first: [text(`回顾：${bare}`)], noTool: true },
  { name: '明确要求不执行时不还原命令', first: [text(`不要执行以下命令：${bare}`)], noTool: true },
  {
    name: '生产回归：旧纠错省略 description 不再影响调用',
    restored: true,
    second: [{ ...bash, input: { command: input.command } }],
  },
  {
    name: '生产回归：旧纠错添加默认 timeout 不再影响调用',
    restored: true,
    second: [{ ...bash, input: { ...input, timeout: 120000 } }],
  },
  {
    name: '本地装配不接受模型第二次改写命令',
    restored: true,
    second: [{ ...bash, input: { command: 'echo changed' } }],
  },
  {
    name: 'Step 7.1 和 7.2 成功后可以继续导出',
    restored: true,
    first: [
      text(
        '后处理完成。\nBash {"command":"python skills/ppt-master/scripts/svg_to_pptx.py projects/user_guide 2>&1 | tail -15","description":"Step 7.3 导出"}',
      ),
    ],
    expectedInput: {
      command:
        'python skills/ppt-master/scripts/svg_to_pptx.py projects/user_guide 2>&1 | tail -15',
      description: 'Step 7.3 导出',
    },
    request: {
      messages: [
        {
          role: 'assistant',
          content: [{
            ...bash,
            id: 'split',
            input: { command: 'python total_md_split.py projects/user_guide 2>&1 | tail -10' },
          }],
        },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'split',
            content: 'Successfully generated 15/15 file(s)',
          }],
        },
        {
          role: 'assistant',
          content: [{
            ...bash,
            id: 'finalize',
            input: { command: 'python finalize_svg.py projects/user_guide 2>&1 | tail -15' },
          }],
        },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'finalize',
            content: '22 icons embedded; 2 images embedded; Done!',
          }],
        },
      ],
    },
  },
  { name: '附件同形：Bash 换行 JSON 进入结构化纠错', restored: true },
  {
    name: '附件拆分备注命令逐字保留',
    restored: true,
    first: [
      text(
        'Bash {"command":"python skills/ppt-master/scripts/total_md_split.py projects/user_guide","description":"Step 7.1 拆分演讲备注"}',
      ),
    ],
    second: [{
      ...bash,
      input: {
        command: 'python skills/ppt-master/scripts/total_md_split.py projects/user_guide',
        description: 'Step 7.1 拆分演讲备注',
      },
    }],
    expectedInput: {
      command: 'python skills/ppt-master/scripts/total_md_split.py projects/user_guide',
      description: 'Step 7.1 拆分演讲备注',
    },
  },
  {
    name: '行内 Bash 调用能够识别',
    first: [text(`现在运行质量检查门禁。 ${bare.replace('\n', ' ')}`)],
    restored: true,
  },
  {
    name: '格式化 JSON 与字段顺序不影响识别',
    first: [
      text(
        `Bash\n${
          JSON.stringify({ description: input.description, command: input.command }, null, 2)
        }`,
      ),
    ],
    restored: true,
  },
  {
    name: '引号、反斜杠、管道与换行不能改写',
    restored: true,
    expectedInput: {
      command: 'python - <<\'PY\'\nprint({"path": "C:\\\\temp"})\nPY\necho "a", b 2>&1 | tail -40',
      timeout: 120000,
      run_in_background: false,
    },
    first: [
      text(
        `Bash ${
          JSON.stringify({
            command:
              'python - <<\'PY\'\nprint({"path": "C:\\\\temp"})\nPY\necho "a", b 2>&1 | tail -40',
            timeout: 120000,
            run_in_background: false,
          })
        }`,
      ),
    ],
    second: [{
      ...bash,
      input: {
        command:
          'python - <<\'PY\'\nprint({"path": "C:\\\\temp"})\nPY\necho "a", b 2>&1 | tail -40',
        timeout: 120000,
        run_in_background: false,
      },
    }],
  },
  {
    name: '直接装配隔离旧模型纠错风险：重试自述完成必须报错',
    second: [text('质量检查已执行。')],
    restored: true,
  },
  {
    name: '直接装配隔离旧模型纠错风险：重试文本转录不能冒充原生调用',
    second: [text(`[tool_use:Bash] id=again input=${JSON.stringify(input)}`)],
    restored: true,
  },
  {
    name: '直接装配隔离旧模型纠错风险：重试返回 Write 必须阻断',
    second: [{ ...bash, name: 'Write', input: { file_path: 'result.txt', content: 'ok' } }],
    restored: true,
  },
  {
    name: '直接装配隔离旧模型纠错风险：重试多个 Bash 必须阻断',
    second: [bash, { ...bash, id: 'bash_2' }],
    restored: true,
  },
  {
    name: '直接装配隔离旧模型纠错风险：纠错不得悄悄改写命令',
    second: [{ ...bash, input: { ...input, command: 'echo changed' } }],
    restored: true,
  },
  {
    name: '直接装配隔离旧模型纠错风险：纠错不得添加后台执行选项',
    second: [{ ...bash, input: { ...input, run_in_background: true } }],
    restored: true,
  },
  {
    name: '客户端 schema 不接受的字段不能进入纠错',
    error: true,
    first: [text(`Bash ${JSON.stringify({ ...input, unknown: true })}`)],
  },
  { name: '空命令必须报错且不重试', first: [text('Bash {"command":"  "}')], error: true },
  {
    name: '截断 JSON 不猜测命令',
    first: [text('Bash {"command":"python checker.py')],
    error: true,
  },
  { name: '多个裸 Bash 不猜测执行顺序', first: [text(`${bare}\n${bare}`)], error: true },
  {
    name: '成功反馈后重复同一命令必须阻断',
    error: true,
    request: {
      messages: [{ role: 'assistant', content: [bash] }, {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: bash.id, content: '已执行' }],
      }],
    },
  },
  {
    name: '服务端已执行时不重放请求',
    first: [{ type: 'server_tool_use', id: 'server_1', name: 'web_fetch', input: {} }, text(bare)],
    error: true,
  },
  { name: '没有声明 Bash 时不触发纠错', request: { tools: [WRITE_TOOL] } },
  { name: 'tool_choice none 不触发纠错', request: { tool_choice: { type: 'none' } } },
  {
    name: '强制 Write 不触发 Bash 纠错',
    request: { tool_choice: { type: 'tool', name: 'Write' } },
  },
  { name: '代码围栏中的 Bash 是示例', first: [text(`示例：\n\`\`\`json\n${bare}\n\`\`\``)] },
  { name: '行内代码中的 Bash 是示例', first: [text(`语法：\`${bare}\``)] },
  { name: 'JSON 字符串中的 Bash 是正文', first: [text(JSON.stringify({ example: bare }))] },
  { name: '结构化 Bash 旁边的文本不重复纠错', first: [bash, text(bare)], expectedInput: input },
  {
    name: 'Write 正文中的 Bash 不触发纠错',
    first: [{ ...bash, name: 'Write', input: { file_path: 'example.md', content: bare } }],
  },
  {
    name: '已存在 Read 调用不被 Bash 纠错替换',
    first: [{ ...bash, name: 'Read', input: { file_path: 'source.md' } }, text(bare)],
  },
  {
    name: '成功 tool_result 续轮不重复执行 Bash',
    first: [text('SVG 质量检查已完成。')],
    request: {
      messages: [{ role: 'assistant', content: [bash] }, {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: bash.id, content: '0 errors' }],
      }],
    },
  },
];

export async function runBashRecoveryCase(
  adapter: { sendRequest(request: AnthropicRequest): Promise<AnthropicResponse> },
  sample: BashCase,
) {
  const originalFetch = globalThis.fetch;
  const calls: AnthropicRequest[] = [];
  const check = (condition: boolean, message: string) => {
    if (!condition) throw new Error(`${sample.name}：${message}`);
  };
  try {
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            content: calls.length === 1 ? sample.first ?? [text(bare)] : sample.second ?? [bash],
            stop_reason: 'end_turn',
            usage: { input_tokens: 121, output_tokens: 17 },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      );
    }) as typeof fetch;
    let response: AnthropicResponse | undefined;
    let error: unknown;
    try {
      response = await adapter.sendRequest({
        model: 'claude-sonnet-5.5',
        tools: [BASH_TOOL, WRITE_TOOL],
        messages: [{ role: 'user', content: '运行 SVG 检查并拆分演讲备注' }],
        ...sample.request,
      });
    } catch (caught) {
      error = caught;
    }
    check(calls.length === 1, `上游请求数为 ${calls.length}`);
    check(Boolean(error) === Boolean(sample.error), `错误状态不符：${String(error)}`);
    if (sample.noTool) {
      check(
        !response?.content.some((block) => block.type === 'tool_use'),
        '示例、历史或否定指令不能下发工具',
      );
    }
    if (sample.error) {
      check(
        error instanceof Error && 'statusCode' in error && error.statusCode === 502,
        '需要明确 502 错误',
      );
    }
    if (!sample.error && (sample.restored || sample.expectedInput)) {
      const tool = response?.content.find((block) =>
        block.type === 'tool_use' && block.name === 'Bash'
      );
      const expected: Record<string, unknown> = sample.expectedInput ?? input;
      check(
        tool?.type === 'tool_use' &&
          Object.keys(tool.input).length === Object.keys(expected).length &&
          Object.keys(expected).every((key) => tool.input[key] === expected[key]),
        '下发参数必须与原始命令逐字一致',
      );
      check(response?.stop_reason === 'tool_use', '必须返回工具续轮语义');
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
}

export async function runBashStreamRecoveryCase(
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
            content: corrected ? [text(bare)] : [text('Bash {"command":"python checker.py')],
            stop_reason: 'end_turn',
            usage: { input_tokens: 121, output_tokens: 17 },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      );
    }) as typeof fetch;
    const response = await post({
      model: 'claude-sonnet-5.5',
      stream: true,
      max_tokens: 8192,
      messages: Array.from({ length: 121 }, (_, index) => ({
        role: index % 2 ? 'assistant' : 'user',
        content: `SVG 检查 ${index}`,
      })),
      tools: [
        BASH_TOOL,
        WRITE_TOOL,
        ...Array.from({ length: 15 }, (_, index) => ({
          name: `Tool_${index}`,
          input_schema: { type: 'object' as const, properties: {} },
        })),
      ],
    });
    if (!corrected && response.status === 502) {
      const body = await response.json();
      if (calls !== 1 || !body.error) throw new Error('Bash 纠错失败需明确返回 API 错误');
      return;
    }
    if (response.status !== 200) throw new Error(`HTTP 状态异常：${response.status}`);
    const events = (await response.text()).split(/\r?\n/).filter((line) => line.startsWith('data:'))
      .map((line) => JSON.parse(line.slice(5).trim()));
    const tools = events.filter((event) =>
      event.type === 'content_block_start' && event.content_block?.type === 'tool_use'
    );
    const errors = events.filter((event) => event.type === 'error');
    if (calls !== 1) throw new Error(`必须只请求上游一次，实际请求 ${calls} 次`);
    if (corrected) {
      const argument = events.filter((event) => event.type === 'content_block_delta')
        .map((event) => event.delta?.partial_json ?? '').join('');
      if (
        tools.length !== 1 || tools[0].content_block.name !== 'Bash' || errors.length ||
        JSON.stringify(JSON.parse(argument)) !== JSON.stringify(input)
      ) {
        throw new Error('客户端必须仅收到原命令的单个 Bash 调用');
      }
      if (
        !events.some((event) =>
          event.type === 'message_delta' && event.delta?.stop_reason === 'tool_use'
        ) || events.at(-1)?.type !== 'message_stop'
      ) {
        throw new Error('成功 Bash 必须有完整工具续轮结束语义');
      }
    } else if (
      tools.length || errors.length !== 1 ||
      events.some((event) =>
        event.type === 'message_delta' && event.delta?.stop_reason === 'end_turn'
      )
    ) {
      throw new Error('纠错失败不能静默结束或下发命令');
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
}

export async function runBashIdStabilityCase(
  adapter: { sendRequest(request: AnthropicRequest): Promise<AnthropicResponse> },
) {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            content: [text(bare)],
            stop_reason: 'end_turn',
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      )) as typeof fetch;
    const request: AnthropicRequest = {
      model: 'claude-sonnet-5.5',
      tools: [BASH_TOOL],
      messages: [{ role: 'user', content: '运行检查' }],
    };
    const first = await adapter.sendRequest(request);
    const second = await adapter.sendRequest(request);
    const one = first.content.find((block) => block.type === 'tool_use');
    const two = second.content.find((block) => block.type === 'tool_use');
    if (!one || !two || one.type !== 'tool_use' || two.type !== 'tool_use' || one.id !== two.id) {
      throw new Error('同一请求重试必须保留同一工具标识');
    }
    const again = await adapter.sendRequest({
      ...request,
      messages: [
        ...request.messages,
        { role: 'assistant', content: first.content },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: one.id, content: 'done' }] },
        { role: 'user', content: '请明确重新执行一次原命令' },
      ],
    });
    const next = again.content.find((block) => block.type === 'tool_use');
    if (!next || next.type !== 'tool_use' || next.id === one.id) {
      throw new Error('新的明确执行请求需要新的工具标识');
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
}
