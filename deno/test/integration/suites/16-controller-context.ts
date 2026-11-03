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
      name: '超过512000字符的SVG会话可以压缩，并保留尾部事实',
      async run({ api, config }) {
        const marker = crypto.randomUUID();
        const history = '<svg><text>已完成页面</text></svg>\n'.repeat(18000) +
          `\n尾部事实：交付国家为德国，唯一标记为${marker}。`;
        assertTrue(history.length > 512000, '历史超过单份正文容量');
        const response = await api.post('/v1/messages', {
          model: config.liveModel,
          system: '请总结会话供后续继续使用，必须保留最后给出的交付国家和唯一标记。',
          max_tokens: 1024,
          messages: [
            { role: 'user', content: '整理已经完成的演示文稿。' },
            { role: 'assistant', content: history },
            { role: 'user', content: '请压缩当前会话，只输出简要摘要和尾部事实。' },
          ],
        });
        assertStatus(response, 200);
        assertAnthropicMessage(response.json, config.liveModel);
        assertIncludes(textOf(response.json), '德国');
        assertIncludes(textOf(response.json), marker);
        return '超过512000字符的完整历史已登记，压缩摘要保留尾部事实';
      },
    },
  ],
};
