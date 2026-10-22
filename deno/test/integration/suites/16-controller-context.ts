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

export const suite: Suite = {
  id: '16',
  title: '主控长会话分片容量与P08续轮',
  cases: [
    {
      name: 'P08：超过16分片的SVG历史保留尾部规范，Read重放及追加继续正常',
      async run({ api, config }) {
        const marker = crypto.randomUUID();
        const path = `C:/isolated/${marker}/spec_lock.md`;
        const system = '<svg xmlns="http://www.w3.org/2000/svg">\n' +
          '<!-- SVG history: completed page -->\n'.repeat(2600) +
          `</svg>\n唯一规范文件路径：${path}。此路径只在历史尾部给出，必须保留原文。`;
        const messages = [{
          role: 'user',
          content:
            'P07法国已完成。先使用Read读取规范指定的唯一路径，然后根据工具结果回答P08国家和标记，不重做既有页面。',
        }];
        const tools = [{
          name: 'Read',
          input_schema: {
            type: 'object',
            properties: { file_path: { type: 'string' } },
            required: ['file_path'],
          },
        }];
        const request = {
          model: config.liveModel,
          system,
          messages,
          tools,
          tool_choice: { type: 'tool', name: 'Read' },
          max_tokens: 2048,
        };
        const bytes = new TextEncoder().encode(JSON.stringify(request)).length;
        assertTrue(
          system.length > 16 * (6000 - 256),
          '历史确实超过两套运行时6000字符配置下的16片阈值',
        );
        assertTrue(bytes < 32 * 1024 * 1024, 'HTTP请求远小于32MB');
        const first = await api.post('/v1/messages', request);
        assertStatus(first, 200);
        assertAnthropicMessage(first.json, request.model);
        assertEquals(first.headers.get('x-sider-controller'), 'true');
        const call = toolUseOf(first.json);
        assertEquals(call?.name, 'Read');
        assertEquals(call.input.file_path, path, '完整历史尾部唯一路径保留');
        const replay = await api.post('/v1/messages', request);
        assertStatus(replay, 200);
        assertEquals(toolUseOf(replay.json)?.id, call.id, '相同请求重放原工具');
        const next = await api.post('/v1/messages', {
          ...request,
          tool_choice: { type: 'none' },
          messages: [...messages, { role: 'assistant', content: first.json.content }, {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: call.id,
              content: `P08国家：德国；唯一事实标记：${marker}`,
            }],
          }, { role: 'user', content: '请继续完成，只回答P08国家和唯一事实标记。' }],
        });
        assertStatus(next, 200);
        assertEquals(next.json.stop_reason, 'end_turn');
        assertEquals(
          next.json.sider_session.conversation_id,
          first.json.sider_session.conversation_id,
        );
        assertIncludes(textOf(next.json), '德国');
        assertIncludes(textOf(next.json), marker);
        return `实际请求${bytes}字节，尾部路径与结果事实完整；重放未生成新工具，追加继续沿用检查点`;
      },
    },
    {
      name: '512000字符内容库边界：明确返回400容量信息，不误报32MB',
      async run({ api, config }) {
        const response = await api.post('/v1/messages', {
          model: config.liveModel,
          system: 'x'.repeat(512001),
          max_tokens: 64,
          messages: [{ role: 'user', content: crypto.randomUUID() }],
        });
        assertStatus(response, 400);
        assertEquals(response.json.error.type, 'invalid_request_error');
        assertIncludes(response.json.error.message, '512000');
        return '内部内容库容量边界保留，错误信息暴露真实限制；不进入模型调用';
      },
    },
  ],
};
