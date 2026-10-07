// deno-lint-ignore-file no-explicit-any -- 集成测试读取工具块与 SSE 的动态结构。
import {
  assertAnthropicMessage,
  assertEquals,
  assertIncludes,
  assertStatus,
  assertTrue,
  type Suite,
  textOf,
  toolUseOf,
} from '../harness.ts';

const MARKER = `PPT-SOURCE-${crypto.randomUUID()}`;
const TOOLS = [
  {
    name: 'mcp__open_websearch__fetchGithubReadme',
    description: 'Fetch a GitHub repository README.',
    input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
  {
    name: 'mcp__webReader__read',
    description: 'Read a public URL and return Markdown.',
    input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
  {
    name: 'Write',
    description: 'Write UTF-8 content to a local file.',
    input_schema: {
      type: 'object',
      properties: { file_path: { type: 'string' }, content: { type: 'string' } },
      required: ['file_path', 'content'],
    },
  },
  ...Array.from(
    { length: 14 },
    (_, index) => ({
      name: `unused_tool_${index}`,
      description: 'Unrelated tool. Do not use for this task.',
      input_schema: { type: 'object', properties: {} },
    }),
  ),
];

export const suite: Suite = {
  id: '11',
  title: 'Claude Code 客户端兼容与 PPT 资料工具循环',
  cases: [
    ...[false, true].map((stream) => ({
      name: `服务端搜索结果仅输出客户端兼容块，流式=${stream}`,
      async run({ api }: any) {
        const body = {
          model: 'claude-opus-5.5',
          max_tokens: 4096,
          stream,
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
          messages: [{
            role: 'user',
            content: '使用网页搜索查询 Python 官方网站最新稳定版本，必须给出来源网址。',
          }],
        };
        if (stream) {
          const res = await api.sse('/v1/messages', body);
          assertEquals(res.status, 200, 'HTTP 状态');
          assertTrue(!res.events.some((event: any) => event.type === 'error'), '无流式错误');
          assertEquals(res.events.at(-1)?.type, 'message_stop', '流完整结束');
          assertIncludes(res.text, 'python.org', '保留官方网站来源');
          return `客户端内容块合法，来源保留，${res.events.length} 个事件`;
        }
        const res = await api.post('/v1/messages', body);
        assertStatus(res, 200);
        assertAnthropicMessage(res.json, 'claude-opus-5.5');
        assertIncludes(textOf(res.json), 'python.org', '保留官方网站来源');
        return `客户端内容块合法，${res.json.content.length} 块，来源保留`;
      },
    })),
    {
      name: '17 工具：README 抓取失败 → webReader → Write 文档',
      async run({ api }: any) {
        const history: any[] = [{
          role: 'user',
          content:
            '先用 mcp__open_websearch__fetchGithubReadme 读取 https://github.com/goldenhawksu/sider2claude，只做这一步。',
        }];
        const request = () => ({
          model: 'claude-opus-5.5',
          max_tokens: 4096,
          tools: TOOLS,
          messages: history,
        });
        const first = await api.post('/v1/messages', request());
        assertStatus(first, 200);
        assertAnthropicMessage(first.json);
        const tool1 = toolUseOf(first.json);
        assertEquals(tool1?.name, TOOLS[0].name, '首轮调用抓取工具');
        assertIncludes(JSON.stringify(tool1.input), 'goldenhawksu/sider2claude', '完整仓库地址');
        history.push({ role: 'assistant', content: first.json.content }, {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: tool1.id,
            is_error: true,
            content: 'README not found or repository does not exist',
          }],
        }, {
          role: 'user',
          content:
            '工具失败不能证明仓库不存在。现在用 mcp__webReader__read 读取 https://raw.githubusercontent.com/goldenhawksu/sider2claude/main/README_CN.md，只调用这个工具。',
        });
        const second = await api.post('/v1/messages', request());
        assertStatus(second, 200);
        assertAnthropicMessage(second.json);
        const tool2 = toolUseOf(second.json);
        assertEquals(tool2?.name, TOOLS[1].name, '失败后改用 webReader');
        assertTrue(tool2.id !== tool1.id, '工具 ID 独立');
        history.push({ role: 'assistant', content: second.json.content }, {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: tool2.id,
            content:
              `# Sider2Claude\n安装：bun install\n配置：AUTH_TOKEN、SIDER_AUTH_TOKEN、DEEPSEEK_BASE_URL。\n资料版本：${MARKER}`,
          }],
        }, {
          role: 'user',
          content:
            `现在只调用 Write，把上述资料整理成用户文档提纲，写到 /repo/ppt-sources.md，内容必须原样保留资料版本 ${MARKER}。不要执行其他工具。`,
        });
        const third = await api.post('/v1/messages', request());
        assertStatus(third, 200);
        assertAnthropicMessage(third.json);
        const tool3 = toolUseOf(third.json);
        assertEquals(tool3?.name, 'Write', '写入资料提纲');
        assertEquals(tool3.input.file_path, '/repo/ppt-sources.md', '目标文件');
        assertIncludes(tool3.input.content, MARKER, '工具结果进入写入内容');
        assertIncludes(tool3.input.content, 'AUTH_TOKEN', '配置资料不丢失');
        return '抓取失败后正确换工具，资料结果进入 Write；17 工具请求不泄漏服务端块';
      },
    },
  ],
};
