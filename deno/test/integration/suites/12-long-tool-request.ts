import {
  assertAnthropicMessage,
  assertEquals,
  assertIncludes,
  assertStatus,
  type Suite,
  toolUseOf,
} from '../harness.ts';

export const suite: Suite = {
  id: '12',
  title: '长历史工具请求',
  cases: [{
    name: '51 条消息、18 个工具：保留完整历史并完成工具调用',
    async run({ api }) {
      const messages = Array.from({ length: 50 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `历史片段 ${index}：${'用户文档需要记录安装、配置、启动和常见问题。'.repeat(20)}`,
      }));
      messages.push({
        role: 'user',
        content:
          '现在只使用 Read 工具读取 /repo/long-source.md，禁止调用其他工具，也不要复述历史。',
      });
      const response = await api.post('/v1/messages', {
        model: 'claude-opus-5.5',
        max_tokens: 4096,
        messages,
        tools: Array.from(
          { length: 18 },
          (_, index) => ({
            name: index === 0 ? 'Read' : `unused_${index}`,
            description: index === 0
              ? 'Read a local file using file_path.'
              : 'Unrelated tool, do not use.',
            input_schema: {
              type: 'object',
              properties: { file_path: { type: 'string' } },
              required: ['file_path'],
            },
          }),
        ),
      });
      assertStatus(response, 200);
      assertAnthropicMessage(response.json, 'claude-opus-5.5');
      const tool = toolUseOf(response.json);
      assertEquals(tool?.name, 'Read', '长历史请求正确选择客户端工具');
      assertIncludes(JSON.stringify(tool.input), '/repo/long-source.md', '工具参数完整');
      assertEquals(response.json.stop_reason, 'tool_use', '结束原因');
      return `51 消息、18 工具完整送达，Read 输入有效，耗时 ${response.ms}ms`;
    },
  }],
};
