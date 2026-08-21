/**
 * 工具调用与路由决策。
 *
 * 路由原则（CLAUDE.md）：出现 Claude Code 内置工具、MCP 工具或自定义工具时
 * 必须走 DeepSeek，因为 Sider 未被证明支持 Anthropic `tool_use`。
 * 判据是响应里没有 `sider_session`。
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
  blockTypes,
  brief,
  type Suite,
  type TestContext,
  textOf,
  toolUseOf,
} from '../harness.ts';

const WEATHER_TOOL = {
  name: 'get_weather',
  description: '查询指定城市的当前天气',
  input_schema: {
    type: 'object',
    properties: { city: { type: 'string', description: '城市名' } },
    required: ['city'],
  },
};

/** Claude Code 内置工具的真实形状（截取常用几个）。 */
const CLAUDE_CODE_TOOLS = [
  {
    name: 'Bash',
    description: 'Executes a bash command in a persistent shell session.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to execute' },
        description: { type: 'string' },
      },
      required: ['command'],
    },
  },
  {
    name: 'Read',
    description: 'Reads a file from the local filesystem.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'The absolute path to the file' },
        limit: { type: 'number' },
      },
      required: ['file_path'],
    },
  },
];

const MCP_TOOL = {
  name: 'mcp__github__list_repos',
  description: '列出某个 owner 名下的 GitHub 仓库',
  input_schema: {
    type: 'object',
    properties: { owner: { type: 'string' } },
    required: ['owner'],
  },
};

export const suite: Suite = {
  id: '05',
  title: '工具调用与路由',
  cases: [
    {
      name: '自定义工具触发 tool_use 并路由到 DeepSeek',
      async run({ api }) {
        const res = await api.post('/v1/messages', {
          model: 'claude-sonnet-4.6',
          max_tokens: 1024,
          tools: [WEATHER_TOOL],
          messages: [{ role: 'user', content: '北京现在天气怎么样？请调用工具查询。' }],
        });
        bailIfUpstreamLimited(res, '自定义工具用例上游限流');
        assertStatus(res, 200);
        assertAnthropicMessage(res.json, 'claude-sonnet-4.6');
        assertEquals(backendOf(res.json), 'deepseek', '路由后端');

        const tu = toolUseOf(res.json);
        assertTrue(!!tu, '返回 tool_use 块');
        assertEquals(tu.name, 'get_weather', 'tool_use.name');
        assertTrue(!!tu.id, 'tool_use.id 非空');
        assertTrue(typeof tu.input === 'object' && tu.input !== null, 'tool_use.input 是对象');
        assertEquals(res.json.stop_reason, 'tool_use', 'stop_reason');
        return `blocks=[${blockTypes(res.json)}] ${tu.name}(${JSON.stringify(tu.input)})`;
      },
    },
    {
      name: 'tool_result 续轮能读到工具结果',
      async run({ api }) {
        const first = await api.post('/v1/messages', {
          model: 'claude-sonnet-4.6',
          max_tokens: 1024,
          tools: [WEATHER_TOOL],
          messages: [{ role: 'user', content: '北京现在天气怎么样？请调用工具查询。' }],
        });
        bailIfUpstreamLimited(first, 'tool_result 用例首轮上游限流');
        const tu = toolUseOf(first.json);
        assertTrue(!!tu, '首轮返回 tool_use');

        const second = await api.post('/v1/messages', {
          model: 'claude-sonnet-4.6',
          max_tokens: 512,
          tools: [WEATHER_TOOL],
          messages: [
            { role: 'user', content: '北京现在天气怎么样？请调用工具查询。' },
            {
              role: 'assistant',
              content: [{ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input }],
            },
            {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: tu.id, content: '晴，28摄氏度' }],
            },
          ],
        });
        bailIfUpstreamLimited(second, 'tool_result 用例续轮上游限流');
        assertStatus(second, 200);
        assertIncludes(textOf(second.json), '28', '续轮回答引用工具结果');
        return brief(textOf(second.json), 70);
      },
    },
    ...CLAUDE_CODE_TOOLS.map((tool) => ({
      name: `Claude Code 内置 ${tool.name} 路由到 DeepSeek`,
      async run({ api }: TestContext) {
        // 给足参数，让工具调用不依赖模型的自主推断，把用例聚焦在路由与透传上。
        const prompt = tool.name === 'Bash'
          ? '用 Bash 工具执行命令 `ls -la`。'
          : '用 Read 工具读取文件 /repo/package.json。';
        const res = await api.post('/v1/messages', {
          model: 'claude-opus-4.8',
          max_tokens: 1024,
          tools: [tool],
          messages: [{ role: 'user', content: prompt }],
        });
        bailIfUpstreamLimited(res, `${tool.name} 用例上游限流`);
        assertStatus(res, 200);
        // 工具请求不允许 fallback 到 Sider，必须由 DeepSeek 承接。
        assertEquals(backendOf(res.json), 'deepseek', '路由后端');
        const tu = toolUseOf(res.json);
        assertTrue(!!tu, `返回 ${tool.name} 的 tool_use 块`);
        assertEquals(tu.name, tool.name, 'tool_use.name');
        return `blocks=[${blockTypes(res.json)}] input=${brief(JSON.stringify(tu.input), 50)}`;
      },
    })),
    {
      name: 'MCP 工具 mcp__* 路由到 DeepSeek',
      async run({ api }) {
        const res = await api.post('/v1/messages', {
          model: 'claude-opus-4.8',
          max_tokens: 1024,
          tools: [MCP_TOOL],
          messages: [{ role: 'user', content: '列出 octocat 名下的仓库。' }],
        });
        bailIfUpstreamLimited(res, 'MCP 用例上游限流');
        assertStatus(res, 200);
        assertEquals(backendOf(res.json), 'deepseek', '路由后端');
        const tu = toolUseOf(res.json);
        assertTrue(!!tu, '返回 tool_use 块');
        assertEquals(tu.name, MCP_TOOL.name, 'tool_use.name 保留 mcp__ 前缀');
        return `${tu.name}(${brief(JSON.stringify(tu.input), 40)})`;
      },
    },
    {
      name: 'tool_choice 强制指定工具',
      async run({ api }) {
        const res = await api.post('/v1/messages', {
          model: 'claude-opus-4.8',
          max_tokens: 1024,
          tools: [WEATHER_TOOL],
          tool_choice: { type: 'tool', name: 'get_weather' },
          messages: [{ role: 'user', content: '广州天气' }],
        });
        bailIfUpstreamLimited(res, 'tool_choice 用例上游限流');
        assertStatus(res, 200);
        const tu = toolUseOf(res.json);
        assertTrue(!!tu, '返回 tool_use 块');
        assertEquals(tu.name, 'get_weather', '强制指定的工具被调用');
        return `${tu.name}(${JSON.stringify(tu.input)})`;
      },
    },
    {
      name: '流式工具调用 SSE 结构完整',
      async run({ api }) {
        const res = await api.sse('/v1/messages', {
          model: 'claude-sonnet-4.6',
          max_tokens: 1024,
          stream: true,
          tools: [WEATHER_TOOL],
          messages: [{ role: 'user', content: '查一下上海的天气。' }],
        });
        assertEquals(res.status, 200, 'HTTP 状态');
        assertTrue(res.paired, 'event/data 行配对');

        const tuStart = res.events.find((e) => e.content_block?.type === 'tool_use');
        assertDefined(tuStart, 'content_block_start 含 tool_use 块');
        assertTrue(!!tuStart.content_block.id, 'tool_use 块带 id');
        assertTrue(
          res.events.some((e) => e.delta?.type === 'input_json_delta'),
          '有 input_json_delta 增量',
        );
        assertTrue(
          res.events.some((e) => e.type === 'content_block_stop'),
          'tool_use 块被闭合',
        );
        return `event行=${res.eventNames.length} tool_use=${tuStart.content_block.name} 增量与闭合完整`;
      },
    },
    {
      name: '多工具并存时按需选择',
      async run({ api }) {
        const res = await api.post('/v1/messages', {
          model: 'claude-opus-4.8',
          max_tokens: 1024,
          tools: [WEATHER_TOOL, ...CLAUDE_CODE_TOOLS, MCP_TOOL],
          messages: [{ role: 'user', content: '帮我查一下深圳的天气。' }],
        });
        bailIfUpstreamLimited(res, '多工具用例上游限流');
        assertStatus(res, 200);
        assertEquals(backendOf(res.json), 'deepseek', '路由后端');
        const tu = toolUseOf(res.json);
        assertTrue(!!tu, '返回 tool_use 块');
        assertEquals(tu.name, 'get_weather', '从 4 个工具中选中了正确的那个');
        return `4 个工具中选中 ${tu.name}`;
      },
    },
  ],
};
