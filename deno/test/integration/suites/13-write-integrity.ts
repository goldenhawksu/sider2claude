import { assertEquals, assertIncludes, assertStatus, assertTrue, type Suite } from '../harness.ts';

export const suite: Suite = {
  id: '13',
  title: '长 JSON 文件写入完整性',
  cases: [{
    name: '12 项 manifest：Windows 路径、嵌套同名字段和长正文完整',
    async run({ api }) {
      const path = String.raw`d:\PPT_Test\projects\用户文档\images\image_prompts.json`;
      const marker = `WRITE-EXACT-${crypto.randomUUID()}`;
      const data = JSON.stringify(
        {
          project: marker,
          items: Array.from({ length: 12 }, (_, index) => ({
            filename: `p${index + 1}.png`,
            file_path: `inner_${index}.png`,
            content: `内层正文 ${index}`,
            aspect_ratio: '16:9',
            prompt: `${marker} 提示词 "保持引号" ${index}。`.repeat(8),
            status: 'Pending',
          })),
        },
        null,
        2,
      );
      // 部署环境的非流式主控总期限约 70 秒，长写必须走流式（Claude Code 的实际形态）。
      const response = await api.sse('/v1/messages', {
        model: 'claude-opus-5.5',
        max_tokens: 8192,
        stream: true,
        tools: [{
          name: 'Write',
          description: 'Write the exact given content to file_path without changing it.',
          input_schema: {
            type: 'object',
            properties: { file_path: { type: 'string' }, content: { type: 'string' } },
            required: ['file_path', 'content'],
          },
        }],
        messages: [{
          role: 'user',
          content:
            `只调用一次 Write，将下面的内容逐字写入目标路径，不要生成脚本、不要改字段、不要加解释。目标路径：${path}\n正文开始\n${data}\n正文结束`,
        }],
      });
      assertStatus(response, 200);
      assertTrue(
        !response.events.some((event: any) => event.type === 'error'),
        '无流式错误',
      );
      assertEquals(response.events.at(-1)?.type, 'message_stop', '流完整结束');
      const blockStart = response.events.find((event: any) =>
        event.type === 'content_block_start' && event.content_block?.type === 'tool_use'
      );
      assertEquals(blockStart?.content_block?.name, 'Write', '客户端工具');
      const partial = response.events
        .filter((event: any) =>
          event.type === 'content_block_delta' && event.index === blockStart?.index &&
          event.delta?.type === 'input_json_delta'
        )
        .map((event: any) => event.delta.partial_json)
        .join('');
      let tool: { name: string; input: any };
      try {
        tool = { name: blockStart.content_block.name, input: JSON.parse(partial) };
      } catch (error) {
        const preview = partial.replace(/\s+/g, ' ').slice(0, 500);
        throw new Error(
          `Write正文不是合法JSON（${partial.length}字符）：${
            error instanceof Error ? error.message : String(error)
          }；预览=${preview}`,
        );
      }
      const final = response.events.find((event: any) => event.type === 'message_delta');
      assertEquals(final?.delta?.stop_reason, 'tool_use', '停止原因');
      assertEquals(tool.input.file_path, path, '目标路径必须完全相同');
      let parsed: { project: string; items: unknown[] };
      try {
        parsed = JSON.parse(tool.input.content);
      } catch (error) {
        const preview = String(tool.input.content).replace(/\s+/g, ' ').slice(0, 500);
        throw new Error(
          `Write正文不是合法JSON（${String(tool.input.content).length}字符）：${
            error instanceof Error ? error.message : String(error)
          }；预览=${preview}`,
        );
      }
      assertEquals(
        JSON.stringify(parsed),
        JSON.stringify(JSON.parse(data)),
        '所有 JSON 字段和值必须保持完整',
      );
      assertEquals(parsed.items.length, 12, 'manifest 项数');
      assertIncludes(parsed.project, marker, '标识保留');
      return '目标路径一致，12 项 JSON 字段和值完整，正文内字段没有覆盖外层参数';
    },
  }],
};
