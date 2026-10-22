// deno-lint-ignore-file no-explicit-any -- 验证真实HTTP和SSE协议。
import {
  assertEquals,
  assertStatus,
  assertTrue,
  type Suite,
  type TestContext,
} from '../harness.ts';

export const suite: Suite = {
  id: '17',
  title: 'P0主控流式接管及生产统计口径',
  cases: [
    {
      name: '主控开启后直接图文JSON及SSE仍由视觉兼容端真实识图',
      async run({ api }) {
        const image =
          'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC';
        const request = {
          model: 'claude-sonnet-5.5',
          max_tokens: 128,
          thinking: { type: 'disabled' },
          messages: [{
            role: 'user',
            content: [{
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: image },
            }, { type: 'text', text: '请看这张图片，只回答占主要面积的颜色。' }],
          }],
        };
        const json = await api.post('/v1/messages', request);
        assertStatus(json, 200);
        assertTrue(!json.headers.get('x-sider-controller'), '视觉输入不进入Sider文本主控');
        const text = json.json.content.filter((block: any) => block.type === 'text').map((
          block: any,
        ) => block.text).join('');
        assertTrue(/红|red/i.test(text), '真实识别图中红色');
        const stream = await api.sse('/v1/messages', { ...request, stream: true });
        assertEquals(stream.status, 200);
        assertTrue(!stream.events.some((event) => event.type === 'error'), '视觉流没有错误');
        assertTrue(/红|red/i.test(stream.text), '流式真实识别图中红色');
        assertEquals(stream.events.at(-1)?.type, 'message_stop');
        return '64×64合成红色图片经兼容端真实识别；JSON及SSE不丢图、不伪造Sider视觉能力';
      },
    },
    {
      name: '有效流式主控开关与调用计数同时暴露在状态、JSON和看板',
      async run({ api }: TestContext) {
        const status = await api.get('/v1/messages/backends/status');
        assertStatus(status, 200);
        assertEquals(status.json.routing.siderController, true);
        assertEquals(status.json.routing.siderControllerStreaming, true);
        const stats = await api.get('/stats.json');
        assertStatus(stats, 200);
        assertEquals(stats.json.controller.streaming, true);
        for (
          const key of [
            'attempts',
            'failed',
            'quotaErrors',
            'completed',
            'contextUploads',
            'cachedReplays',
            'telemetryDropped',
          ]
        ) {
          assertTrue(typeof stats.json.siderActivity.totals[key] === 'number', `计数${key}存在`);
        }
        const page = await api.get('/stats');
        assertStatus(page, 200);
        assertTrue(page.text.includes('流式接管：启用'), '页面显示真实有效开关');
        assertTrue(page.text.includes('业务完成响应'), '完成响应与内部模型调用分开');
        return '状态、看板及JSON一致；新增调用计数独立于旧统计及采样明细';
      },
    },
    ...['claude-opus-5.5', 'claude-sonnet-5.5'].map((model) => ({
      name: `${model}：真实SSE Read→Write→完成，文件字节保真与重放计数正确`,
      async run({ api }: TestContext) {
        const directory = await Deno.makeTempDir({ dir: '.runtime', prefix: 'p0-e2e-' });
        const absolute = `${Deno.cwd().replaceAll('\\', '/')}/${directory.replaceAll('\\', '/')}`;
        const sourcePath = `${absolute}/source.json`, targetPath = `${absolute}/output.json`;
        const source = JSON.stringify(
          {
            images: Array.from(
              { length: 12 },
              (_, i) => ({
                id: i + 1,
                prompt: `中文引号"与反斜杠\\及换行\n😀${crypto.randomUUID()}`,
              }),
            ),
          },
          null,
          2,
        );
        await Deno.writeTextFile(sourcePath, source);
        const messages: any[] = [{
          role: 'user',
          content:
            `先用Read读取${sourcePath}，再用Write逐字复制完整JSON正文到${targetPath}。必须保留全部12项、引号、反斜杠、换行和Unicode；Write成功后再报告完成。`,
        }];
        const tools = [
          {
            name: 'Read',
            input_schema: {
              type: 'object',
              properties: { file_path: { type: 'string' } },
              required: ['file_path'],
            },
          },
          {
            name: 'Write',
            input_schema: {
              type: 'object',
              properties: { file_path: { type: 'string' }, content: { type: 'string' } },
              required: ['file_path', 'content'],
            },
          },
        ];
        const before = (await api.get('/stats.json')).json.siderActivity;
        let writeSuccess = false, completed = false, firstReplay = false;
        for (let round = 0; round < 7; round++) {
          const request = {
            model,
            stream: true,
            max_tokens: 4096,
            tools,
            messages,
            ...(round === 0 ? { tool_choice: { type: 'tool', name: 'Read' } } : {}),
          };
          const result = await api.sse('/v1/messages', request);
          assertEquals(result.status, 200);
          assertTrue(result.paired, 'SSE事件配对');
          assertTrue(!result.events.some((event) => event.type === 'error'), '流内没有错误');
          assertEquals(result.events.at(-1)?.type, 'message_stop');
          const callEvent = result.events.find((event) =>
            event.type === 'content_block_start' && event.content_block?.type === 'tool_use'
          );
          if (!callEvent) {
            assertTrue(writeSuccess, '必须已经收到真实Write成功反馈');
            completed = true;
            break;
          }
          const call = callEvent.content_block;
          const input = JSON.parse(
            result.events.filter((event) =>
              event.index === callEvent.index && event.delta?.type === 'input_json_delta'
            ).map((event) => event.delta.partial_json).join(''),
          );
          if (!firstReplay) {
            const replay = await api.sse('/v1/messages', request);
            assertEquals(replay.status, 200);
            assertEquals(
              replay.events.find((event) => event.content_block?.type === 'tool_use')?.content_block
                .id,
              call.id,
              '重复请求重放原工具ID',
            );
            firstReplay = true;
          }
          let feedback: string;
          if (call.name === 'Read') {
            assertTrue(
              input.file_path === sourcePath || (writeSuccess && input.file_path === targetPath),
              '只读取本用例源文件或已写目标',
            );
            const text = await Deno.readTextFile(input.file_path);
            feedback = text.split('\n').map((line, i) => `${i + 1}\t${line}`).join('\n');
          } else {
            assertEquals(call.name, 'Write');
            assertEquals(writeSuccess, false, '写入成功后不得重放Write');
            assertEquals(input.file_path, targetPath);
            assertEquals(input.content, source, '交给客户端的Write正文逐字一致');
            await Deno.writeTextFile(targetPath, input.content);
            writeSuccess = true;
            feedback = 'Write执行成功，目标文件已创建，完整JSON包含12项。';
          }
          messages.push({
            role: 'assistant',
            content: [{ type: 'tool_use', id: call.id, name: call.name, input }],
          }, {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: call.id, content: feedback }],
          });
        }
        assertTrue(completed, '有限轮次内完成');
        const output = await Deno.readTextFile(targetPath);
        assertEquals(output, source, '实际文件逐字保真');
        assertEquals(JSON.parse(output).images.length, 12);
        const sourceBytes = await Deno.readFile(sourcePath),
          outputBytes = await Deno.readFile(targetPath);
        assertTrue(
          sourceBytes.length === outputBytes.length &&
            sourceBytes.every((byte, i) => outputBytes[i] === byte),
          '实际文件字节完全一致',
        );
        const deadline = Date.now() + 15000;
        let stats;
        do {
          stats = (await api.get('/stats.json')).json;
          if (
            stats.siderActivity.totals.cachedReplays > before.totals.cachedReplays &&
            stats.recent.some((entry: any) =>
              entry.actualModel === model && entry.mode === 'controller' && entry.stream
            )
          ) break;
          await new Promise((resolve) => setTimeout(resolve, 500));
        } while (Date.now() < deadline);
        assertTrue(
          stats.siderActivity.totals.cachedReplays > before.totals.cachedReplays,
          '主控重放计数增长',
        );
        assertTrue(
          stats.siderActivity.totals.completed > before.totals.completed,
          '业务完成计数增长',
        );
        assertTrue(
          stats.recent.some((entry: any) =>
            entry.actualModel === model && entry.mode === 'controller' && entry.stream
          ),
          '实际模型和流式主控模式已持久记录',
        );
        return `真实SSE工具循环收敛；${outputBytes.length}字节、12项JSON完整，Write仅执行一次，重放计数增长`;
      },
    })),
  ],
};
