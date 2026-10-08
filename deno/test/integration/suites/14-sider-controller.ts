// deno-lint-ignore-file no-explicit-any -- 真实客户端协议检查。
import {
  ApiClient,
  assertAnthropicMessage,
  assertEquals,
  assertStatus,
  assertTrue,
  type Suite,
  textOf,
  toolUseOf,
} from '../harness.ts';

const tools = [
  {
    name: 'Read',
    description: '读取本地文件',
    input_schema: {
      type: 'object',
      properties: { file_path: { type: 'string' } },
      required: ['file_path'],
    },
  },
  {
    name: 'Write',
    description: '写入完整文件',
    input_schema: {
      type: 'object',
      properties: { file_path: { type: 'string' }, content: { type: 'string' } },
      required: ['file_path', 'content'],
    },
  },
  {
    name: 'mcp__web__fetchGithubReadme',
    description: '读取GitHub README',
    input_schema: {
      type: 'object',
      properties: { repository: { type: 'string' } },
      required: ['repository'],
    },
  },
  {
    name: 'mcp__web__webReader',
    description: '读取完整URL',
    input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
];
const models = ['claude-opus-5.5', 'claude-sonnet-5.5'];
export const suite: Suite = {
  id: '14',
  title: 'Sider主控真实工具循环、长正文及上下文登记',
  cases: [
    ...models.map((model) => ({
      name: `${model}：Read→纯结果续轮→结束及请求重放`,
      async run({ api }: any) {
        const path = `C:/isolated/${crypto.randomUUID()}/config.json`;
        const messages: any[] = [{
          role: 'user',
          content: `调用Read读取${path}，随后根据结果回答端口。`,
        }];
        const request = { model, tools, messages, max_tokens: 4096 };
        const first = await api.post('/v1/messages', request);
        assertStatus(first, 200);
        assertAnthropicMessage(first.json, model);
        assertEquals(first.headers.get('x-sider-controller'), 'true');
        const call = toolUseOf(first.json);
        assertEquals(call?.name, 'Read');
        assertEquals(call.input.file_path, path);
        const replay = await api.post('/v1/messages', request);
        assertStatus(replay, 200);
        assertEquals(toolUseOf(replay.json).id, call.id, '重放必须保持原工具id');
        messages.push({ role: 'assistant', content: first.json.content }, {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: call.id, content: '{"port":18765}' }],
        });
        const next = await api.post('/v1/messages', { ...request, messages });
        assertStatus(next, 200);
        assertEquals(next.json.stop_reason, 'end_turn');
        assertTrue(textOf(next.json).includes('18765'), '纯工具结果进入主控回答');
        return '实际Sider主控，Read参数正确；重放不新建工具；无cid续轮正确结束';
      },
    })),
    ...models.map((model) => ({
      name: `${model}：StoreContent→WriteFromRef，12项长正文逐字保真`,
      async run({ api }: any) {
        const content = JSON.stringify(
          {
            images: Array.from(
              { length: 12 },
              (_, i) => ({
                id: `image_${i + 1}`,
                file_path: `assets/page_${i + 1}.png`,
                prompt: `第${
                  i + 1
                }页：中文与双引号"file_path"、反斜杠\\、换行\n😀。${crypto.randomUUID()}`,
              }),
            ),
          },
          null,
          2,
        );
        const path = `C:/isolated/${crypto.randomUUID()}/manifest.json`;
        const result = await api.post('/v1/messages', {
          model,
          tools,
          max_tokens: 8192,
          messages: [{
            role: 'user',
            content:
              `请先使用StoreContent保存正文，然后WriteFromRef写入${path}。content必须逐字等于以下JSON字符串解码后的正文，不增删改任何字符：\n${
                JSON.stringify(content)
              }`,
          }],
        });
        assertStatus(result, 200);
        assertAnthropicMessage(result.json, model);
        const call = toolUseOf(result.json);
        assertEquals(call?.name, 'Write');
        assertEquals(call.input.file_path, path);
        assertEquals(call.input.content, content, '正文逐字保真');
        assertEquals(JSON.parse(call.input.content).images.length, 12);
        return `已展开为客户端Write，${content.length}字符和12项内容全部一致`;
      },
    })),
    ...models.map((model) => ({
      name: `${model}：抓取失败换来源→Write→完成`,
      async run({ api }: any) {
        const marker = crypto.randomUUID(), path = `C:/isolated/${marker}/facts.json`;
        const messages: any[] = [{
          role: 'user',
          content:
            `先用mcp__web__fetchGithubReadme读取goldenhawksu/sider2claude。失败需改用mcp__web__webReader读取https://raw.githubusercontent.com/goldenhawksu/sider2claude/main/README_CN.md。读取后写入事实JSON到${path}，最后报告完成。`,
        }];
        for (let round = 0; round < 4; round++) {
          const result = await api.post('/v1/messages', {
            model,
            tools,
            messages,
            max_tokens: 4096,
          });
          assertStatus(result, 200);
          const call = toolUseOf(result.json);
          if (round === 3) {
            assertEquals(result.json.stop_reason, 'end_turn');
            assertTrue(!call, '完成后不重复调用');
            break;
          }
          const expected = ['mcp__web__fetchGithubReadme', 'mcp__web__webReader', 'Write'][round];
          assertEquals(call?.name, expected);
          if (round === 2) {
            assertEquals(call.input.file_path, path);
            assertTrue(call.input.content.includes(marker), '正文保留工具事实标记');
            JSON.parse(call.input.content);
          }
          const content = round === 0
            ? 'README not found or repository does not exist'
            : round === 1
            ? `项目名Sider2Claude；兼容Anthropic Messages API；事实验证标记${marker}。`
            : '写入成功，JSON校验通过。';
          messages.push({ role: 'assistant', content: result.json.content }, {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: call.id,
              is_error: round === 0,
              content,
            }],
          });
        }
        return '四轮主控流程收敛；合成工具结果明确标识，未执行用户文件操作';
      },
    })),
    ...models.map((model) => ({
      name: `${model}：SSE工具输入完整并以tool_use结束`,
      async run({ api }: any) {
        const path = `C:/isolated/${crypto.randomUUID()}/SKILL.md`;
        const result = await api.sse('/v1/messages', {
          model,
          tools: [tools[0]],
          stream: true,
          max_tokens: 2048,
          messages: [{ role: 'user', content: `请先用Read读取${path}。` }],
        });
        assertEquals(result.status, 200);
        assertTrue(!result.events.some((e: any) => e.type === 'error'), '无流内错误');
        assertTrue(result.paired, 'event/data配对');
        const block = result.events.find((e: any) =>
          e.type === 'content_block_start' && e.content_block.type === 'tool_use'
        );
        assertEquals(block?.content_block.name, 'Read');
        const input = JSON.parse(
          result.events.filter((e: any) => e.delta?.type === 'input_json_delta').map((e: any) =>
            e.delta.partial_json
          ).join(''),
        );
        assertEquals(input.file_path, path);
        assertEquals(
          result.events.find((e: any) => e.type === 'message_delta')?.delta.stop_reason,
          'tool_use',
        );
        assertEquals(result.events.at(-1)?.type, 'message_stop');
        return 'Claude Code可识别的工具块和完整JSON增量，未泄漏文本调用行';
      },
    })),
    {
      name: '完整大system及大工具schema分段登记后正确调用Read',
      async run({ api }: any) {
        const path = `C:/isolated/${crypto.randomUUID()}/SKILL.md`;
        const system = `项目技能文件唯一路径：${path}。\n` +
          Array.from(
            { length: 600 },
            (_, i) =>
              `第${i + 1}条制作规范：第${
                i % 12 + 1
              }页必须保持标题、正文、图片、图注之间的对应关系；处理工具结果后再确认事实，不能声称已完成尚未执行的操作。`,
          )
            .join('\n');
        const bigTools = tools.map((tool, index) => ({
          ...tool,
          description: tool.description + (index === 0
            ? Array.from(
              { length: 140 },
              (_, i) =>
                `参数说明${i + 1}：file_path是完整技能文件路径，必须原样保留，不猜测文件内容。`,
            ).join('\n')
            : ''),
        }));
        const result = await api.post('/v1/messages', {
          model: models[0],
          tools: bigTools,
          system,
          messages: [{ role: 'user', content: '请先读取规范规定的唯一技能文件路径，用Read调用。' }],
          max_tokens: 2048,
        });
        assertStatus(result, 200);
        const call = toolUseOf(result.json);
        assertEquals(call?.name, 'Read');
        assertEquals(call.input.file_path, path);
        return `system=${system.length}字符，工具定义完整保留，分段后选型及路径正确`;
      },
    },
    ...(Deno.env.get('E2E_CONTROLLER_SECOND_URL')
      ? [{
        name: '两个独立服务进程：工具结果移动实例后恢复Sider主控检查点',
        async run({ api, config }: any) {
          const second = new ApiClient({
            ...config,
            baseUrl: Deno.env.get('E2E_CONTROLLER_SECOND_URL'),
          });
          const messages: any[] = [{
            role: 'user',
            content: `读取C:/isolated/${crypto.randomUUID()}/config.json并根据结果报告port。`,
          }];
          const request = { model: models[0], tools, messages, max_tokens: 2048 };
          const first = await api.post('/v1/messages', request);
          assertStatus(first, 200);
          const call = toolUseOf(first.json);
          assertEquals(call?.name, 'Read');
          messages.push({ role: 'assistant', content: first.json.content }, {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: call.id, content: '{"port":19987}' }],
          });
          const next = await second.post('/v1/messages', { ...request, messages });
          assertStatus(next, 200);
          assertEquals(next.json.stop_reason, 'end_turn');
          assertTrue(textOf(next.json).includes('19987'), '另一进程恢复工具反馈');
          assertEquals(
            next.json.sider_session.conversation_id,
            first.json.sider_session.conversation_id,
            '代理任务id保持一致',
          );
          return '请求分别由两个独立进程处理，持久化主控会话正确续轮，未回退GLM';
        },
      }]
      : []),
  ],
};
