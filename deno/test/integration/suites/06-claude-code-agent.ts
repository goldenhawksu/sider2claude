// deno-lint-ignore-file no-explicit-any -- 集成测试要读取形状不固定的上游 JSON，any 是恰当选择。
/**
 * 模拟 Claude Code 的真实调用模式，验证持续对话与工具调用两项核心能力。
 *
 * 与 05 套件的单次工具调用不同，这里跑的是完整 agent 循环：
 *   user → assistant(tool_use) → tool_result → assistant(tool_use) → tool_result
 *        → assistant(text) → user(追问) → assistant(text)
 * 每一轮都把上一轮的完整历史回传，这正是 Claude Code 的工作方式，
 * 也是最容易暴露"历史工具轮转录"问题的路径（DeepSeek 对 thinking passback 校验很严）。
 *
 * 按需求分别用一个 Sonnet 模型和一个 Opus 模型各跑一遍。
 */

import {
  assertAnthropicMessage,
  assertDefined,
  assertEquals,
  assertIncludes,
  assertStatus,
  assertTrue,
  backendOf,
  bailIfUpstreamLimited,
  brief,
  type JsonResult,
  type Suite,
  type TestContext,
  textOf,
  toolUseOf,
  UpstreamLimited,
} from '../harness.ts';

/** 每次运行唯一，既当版本号标记，又能避开重复请求缓存。 */
const RUN_MARKER = `9.8.7-e2e-${Date.now().toString(36)}`;

/** Claude Code 实际发送的 system prompt 形态：数组 + cache_control。 */
const CLAUDE_CODE_SYSTEM = [
  {
    type: 'text',
    text: 'You are Claude Code, Anthropic\'s official CLI for Claude.',
    cache_control: { type: 'ephemeral' },
  },
  {
    type: 'text',
    text:
      'You are an interactive CLI tool that helps users with software engineering tasks. ' +
      'Use the available tools to inspect the repository before answering. ' +
      'Be concise and direct.',
    cache_control: { type: 'ephemeral' },
  },
];

/** Claude Code 内置工具集（取常用子集，schema 与真实形状一致）。 */
const CC_TOOLS = [
  {
    name: 'Bash',
    description: 'Executes a bash command in a persistent shell session.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to execute' },
        description: { type: 'string', description: 'Clear, concise description' },
      },
      required: ['command'],
    },
  },
  {
    name: 'Read',
    description: 'Reads a file from the local filesystem. file_path must be absolute.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'The absolute path to the file to read' },
        limit: { type: 'number', description: 'Number of lines to read' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'Glob',
    description: 'Fast file pattern matching tool that works with any codebase size.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'The glob pattern to match files against' },
        path: { type: 'string' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'Edit',
    description: 'Performs exact string replacements in files.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'TodoWrite',
    description: 'Create and update a task list for the current session.',
    input_schema: {
      type: 'object',
      properties: { todos: { type: 'array', items: { type: 'object' } } },
      required: ['todos'],
    },
  },
];

type Message = { role: 'user' | 'assistant'; content: any };

function ccRequest(model: string, messages: Message[], stream = false) {
  return {
    model,
    max_tokens: 4096,
    system: CLAUDE_CODE_SYSTEM,
    tools: CC_TOOLS,
    messages,
    metadata: { user_id: 'e2e-integration-suite' },
    ...(stream ? { stream: true } : {}),
  };
}

/** 断言一轮 agent 响应：结构合法、走 DeepSeek、对外模型名不变。 */
function assertAgentTurn(res: JsonResult, model: string, turn: string): void {
  bailIfUpstreamLimited(res, `${model} ${turn} 上游限流`);
  assertStatus(res, 200);
  assertAnthropicMessage(res.json, model);
  assertEquals(backendOf(res.json), 'deepseek', `${turn} 路由后端`);
}

/**
 * 跑一整轮 Claude Code agent 循环。
 * 返回给报告的摘要串，同时在过程中做逐轮断言。
 *
 * 用独立的 X-Conversation-ID 隔离会话，避免与其他套件抢占
 * `continuous-conversation` 这个全局槽位（该槽位的污染问题由本套件末尾的
 * 专项用例单独复现）。
 */
async function runAgentLoop(ctx: TestContext, model: string): Promise<string> {
  const { api } = ctx;
  const history: Message[] = [];
  const trace: string[] = [];
  const cid = `e2e-agent-${model}-${RUN_MARKER}`;
  const post = (messages: Message[]) =>
    api.postWith('/v1/messages', ccRequest(model, messages), { 'X-Conversation-ID': cid });

  // ── 轮 1：要求列目录，期望模型发起工具调用 ──
  history.push({
    role: 'user',
    content: '用 Glob 工具找出仓库根目录下的 package.json，只做这一步。',
  });
  const turn1 = await post(history);
  assertAgentTurn(turn1, model, '轮1');
  const tool1 = toolUseOf(turn1.json);
  assertTrue(!!tool1, '轮1 返回 tool_use 块');
  assertTrue(!!tool1.id && !!tool1.name, '轮1 tool_use 带 id 与 name');
  trace.push(`轮1→${tool1.name}`);

  // ── 轮 2：回传工具结果，期望模型继续调用 Read ──
  history.push({ role: 'assistant', content: turn1.json.content });
  history.push({
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: tool1.id,
      content: '/repo/package.json',
    }],
  });
  history.push({
    role: 'user',
    content: '现在用 Read 工具读取 /repo/package.json。',
  });
  const turn2 = await post(history);
  assertAgentTurn(turn2, model, '轮2');
  const tool2 = toolUseOf(turn2.json);
  assertTrue(!!tool2, '轮2 返回 tool_use 块（连续第二次工具调用）');
  assertEquals(tool2.name, 'Read', '轮2 调用 Read');
  assertTrue(tool2.id !== tool1.id, '轮2 tool_use.id 与轮1 不同');
  trace.push(`轮2→${tool2.name}`);

  // ── 轮 3：回传文件内容，期望模型基于工具结果作答 ──
  history.push({ role: 'assistant', content: turn2.json.content });
  history.push({
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: tool2.id,
      content: JSON.stringify(
        { name: 'sider2claude', version: RUN_MARKER, type: 'module' },
        null,
        2,
      ),
    }],
  });
  history.push({ role: 'user', content: '这个项目的 version 字段是什么？只回答版本号本身。' });
  const turn3 = await post(history);
  assertAgentTurn(turn3, model, '轮3');
  const answer3 = textOf(turn3.json);
  // 工具结果必须真正进入模型上下文，而不是被丢弃。
  assertIncludes(answer3, RUN_MARKER, '轮3 回答引用工具返回的版本号');
  trace.push('轮3→引用工具结果');

  // ── 轮 4：追问早期信息，验证跨多轮持续对话记忆 ──
  history.push({ role: 'assistant', content: turn3.json.content });
  history.push({
    role: 'user',
    content: '我们刚才用 Read 工具读的那个文件，文件名叫什么？只回答文件名。',
  });
  const turn4 = await post(history);
  assertAgentTurn(turn4, model, '轮4');
  const answer4 = textOf(turn4.json);
  assertIncludes(answer4, 'package.json', '轮4 记得三轮之前的文件名');
  trace.push('轮4→跨3轮记忆');

  const turns = history.filter((m) => m.role === 'user').length;
  return `${trace.join(' | ')}；累计 ${turns} 个 user 轮、${history.length} 条历史消息`;
}

function agentCases(label: string, modelKey: 'claudeCodeSonnet' | 'claudeCodeOpus') {
  return [
    {
      name: `${label} 完整 agent 循环（4 轮）`,
      async run(ctx: TestContext) {
        const model = ctx.config[modelKey];
        return `${model}：${await runAgentLoop(ctx, model)}`;
      },
    },
    {
      name: `${label} 流式 agent 首轮`,
      async run(ctx: TestContext) {
        const model = ctx.config[modelKey];
        // Claude Code 实际以流式发起请求，工具块必须在流里完整闭合。
        const res = await ctx.api.sse(
          '/v1/messages',
          ccRequest(model, [{
            role: 'user',
            content: '用 Bash 工具执行 ls 查看当前目录。',
          }], true),
        );
        assertEquals(res.status, 200, 'HTTP 状态');

        const err = res.events.find((e) => e.type === 'error');
        if (err?.error?.type === 'rate_limit_error') {
          assertTrue(false, `不应限流（工具请求走 DeepSeek）：${brief(err.error.message, 80)}`);
        }
        // DeepSeek 偶发网络故障（broken pipe 等）时本服务在流内发 api_error 事件，
        // 属外部依赖抖动而非缺陷，转 upstream 结果避免误报。
        if (
          err?.error?.type === 'api_error' &&
          /connection error|broken pipe|fetch failed|network|timeout/i.test(
            err.error.message ?? '',
          )
        ) {
          throw new UpstreamLimited(`${model} DeepSeek 网络抖动：${brief(err.error.message, 100)}`);
        }

        assertTrue(res.paired, 'event/data 行配对');
        assertEquals(res.events[0]?.type, 'message_start', '首事件');
        assertEquals(res.events[res.events.length - 1]?.type, 'message_stop', '末事件');

        const tuStart = res.events.find((e) => e.content_block?.type === 'tool_use');
        assertDefined(tuStart, '流内出现 tool_use 块');
        assertTrue(!!tuStart.content_block.id, 'tool_use 带 id');

        const starts = res.events.filter((e) => e.type === 'content_block_start').length;
        const stops = res.events.filter((e) => e.type === 'content_block_stop').length;
        assertEquals(stops, starts, '所有内容块都闭合');

        const msgStart = res.events[0];
        assertEquals(msgStart.message?.model, model, '流内对外模型名');
        return `${model}：event行=${res.eventNames.length} 块=${starts} tool_use=${tuStart.content_block.name}`;
      },
    },
    {
      name: `${label} 压缩历史（thinking 已转录）不报 400`,
      async run(ctx: TestContext) {
        const model = ctx.config[modelKey];
        // Claude Code 压缩上下文后会把历史 thinking/tool_use 一并回传，
        // DeepSeek 对 content[].thinking passback 校验很严，本服务需转录为文本。
        const res = await ctx.api.post(
          '/v1/messages',
          ccRequest(model, [
            { role: 'user', content: '读取 config.json' },
            {
              role: 'assistant',
              content: [
                { type: 'thinking', thinking: '用户想读配置文件，我应该调用 Read。', signature: 'sig-e2e' },
                { type: 'tool_use', id: 'toolu_e2e_hist', name: 'Read', input: { file_path: '/repo/config.json' } },
              ],
            },
            {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: 'toolu_e2e_hist', content: '{"debug": true}' }],
            },
            { role: 'user', content: '刚才那个配置里 debug 是什么值？只回答值本身。' },
          ]),
        );
        bailIfUpstreamLimited(res, `${model} 压缩历史用例上游限流`);
        // 本用例的目标是：历史 thinking/tool_use/tool_result 被正确转录，
        // 不触发 DeepSeek 的 content[].thinking passback 400。回答内容不强断言——
        // 模型偶尔改用工具作答（stop=tool_use）或把 token 花在 thinking 上
        // （stop=max_tokens，text 为空），都不算转录失败。
        assertStatus(res, 200);
        assertAnthropicMessage(res.json, model);
        const answer = textOf(res.json);
        if (!answer.toLowerCase().includes('true')) {
          assertTrue(
            res.json.stop_reason === 'max_tokens' || res.json.stop_reason === 'tool_use',
            `未答出 true 时应是模型行为偏差（实际 stop=${res.json.stop_reason} answer=${brief(answer, 40)}）`,
          );
          return `${model}：透传成功（未触发上游 400），模型本轮选择 ${res.json.stop_reason}`;
        }
        return `${model}：历史 thinking+tool_use+tool_result 正常透传，未触发上游 400`;
      },
    },
  ];
}

export const suite: Suite = {
  id: '06',
  title: 'Claude Code 模拟（持续对话 + 工具调用）',
  cases: [
    ...agentCases('Sonnet', 'claudeCodeSonnet'),
    ...agentCases('Opus', 'claudeCodeOpus'),
    {
      name: '匿名多轮对话不污染后续工具路由',
      async run({ api, config }) {
        // Claude Code 不发 X-Conversation-ID，服务会把所有匿名多轮请求归到
        // 同一个魔法会话 `continuous-conversation`。先跑一轮无工具多轮对话
        // （会被记为 sider），再发一个带工具的 tool_result 续轮：
        // 后者必须按"有工具就走 DeepSeek"路由，而不是延续前者的 sider。
        const chat = await api.post('/v1/messages', {
          model: config.liveModel,
          max_tokens: 128,
          messages: [
            { role: 'user', content: '记住数字 40711。' },
            { role: 'assistant', content: '好的，我记住了 40711。' },
            { role: 'user', content: '刚才的数字是多少？只回答数字。' },
          ],
        });
        bailIfUpstreamLimited(chat, '前置多轮对话上游限流');
        assertStatus(chat, 200);

        const toolTurn = await api.post('/v1/messages', ccRequest(config.claudeCodeSonnet, [
          { role: 'user', content: '用 Bash 工具执行 ls。' },
          {
            role: 'assistant',
            content: [{
              type: 'tool_use',
              id: 'toolu_e2e_pollution',
              name: 'Bash',
              input: { command: 'ls' },
            }],
          },
          {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: 'toolu_e2e_pollution',
              content: 'README.md package.json src',
            }],
          },
          { role: 'user', content: '现在用 Read 工具读取 package.json。' },
        ]));
        bailIfUpstreamLimited(toolTurn, '工具续轮上游限流');
        assertStatus(toolTurn, 200);
        assertEquals(
          backendOf(toolTurn.json),
          'deepseek',
          '带工具的 tool_result 续轮路由后端（不应被前一轮匿名对话的 sider 记录带偏）',
        );
        const tu = toolUseOf(toolTurn.json);
        assertTrue(!!tu, '工具续轮返回 tool_use 块');
        return `前置对话走 ${backendOf(chat.json)}，工具续轮仍走 deepseek → ${tu.name}`;
      },
    },
    {
      name: '两模型 tool_use id 互不串扰',
      async run({ api, config }) {
        // 并发发起两个模型的工具请求，确认会话/工具状态不会互相污染。
        const [sonnet, opus] = await Promise.all([
          api.post('/v1/messages', ccRequest(config.claudeCodeSonnet, [{
            role: 'user',
            content: '用 Read 工具读取 /repo/a-sonnet.txt。',
          }])),
          api.post('/v1/messages', ccRequest(config.claudeCodeOpus, [{
            role: 'user',
            content: '用 Read 工具读取 /repo/b-opus.txt。',
          }])),
        ]);
        bailIfUpstreamLimited(sonnet, '并发用例上游限流');
        bailIfUpstreamLimited(opus, '并发用例上游限流');
        assertStatus(sonnet, 200);
        assertStatus(opus, 200);

        const ts = toolUseOf(sonnet.json);
        const to = toolUseOf(opus.json);
        assertTrue(!!ts && !!to, '两个响应都含 tool_use');
        assertTrue(ts.id !== to.id, 'tool_use.id 不重复');
        assertEquals(sonnet.json.model, config.claudeCodeSonnet, 'Sonnet 对外模型名');
        assertEquals(opus.json.model, config.claudeCodeOpus, 'Opus 对外模型名');
        assertIncludes(JSON.stringify(ts.input), 'sonnet', 'Sonnet 请求参数未串扰');
        assertIncludes(JSON.stringify(to.input), 'opus', 'Opus 请求参数未串扰');
        return `并发两模型，id 与入参均独立`;
      },
    },
  ],
};
