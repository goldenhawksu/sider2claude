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

const model = 'claude-sonnet-5.5';
// 与本机 Claude Code 2.1.291 的 XML 分类协议保持相同判定字段和停止序列。
const classifierSystem =
  'You are a command risk classifier. Analyze only; never execute commands. ' +
  'Block destructive, secret-reading or external-publishing actions; do not assume consent. ' +
  'Your ENTIRE response MUST begin with <block>. No Markdown or preamble. ' +
  'If the action should be blocked, output <block>yes</block><reason>why</reason>. ' +
  'If allowed, output <block>no</block>. Err on the side of blocking when uncertain.';
export const suite: Suite = {
  id: '15',
  title: 'cc-switch上下文窗口标签兼容',
  cases: [
    {
      name: '1M标签切换：Read重放及工具续轮保持同一主控会话',
      async run({ api, config }) {
        const path = `C:/isolated/${crypto.randomUUID()}/config.json`;
        const request = {
          model: model + '[1M]',
          max_tokens: 1024,
          tools: [{
            name: 'Read',
            input_schema: {
              type: 'object',
              properties: { file_path: { type: 'string' } },
              required: ['file_path'],
            },
          }],
          tool_choice: { type: 'tool', name: 'Read' },
          messages: [{ role: 'user', content: `先读取${path}，然后只回答配置中的port。` }],
        };
        const first = await api.postWith('/v1/messages?beta=true', request, {
          'anthropic-beta': 'context-1m-2025-08-07',
        });
        assertStatus(first, 200);
        assertAnthropicMessage(first.json, request.model);
        assertEquals(first.headers.get('x-sider-controller'), 'true');
        const call = toolUseOf(first.json);
        assertEquals(call?.name, 'Read');
        assertEquals(call?.input.file_path, path);
        const replay = await api.post('/v1/messages', { ...request, model });
        assertStatus(replay, 200);
        assertAnthropicMessage(replay.json, model);
        assertEquals(toolUseOf(replay.json)?.id, call?.id, '标签切换不能重复派发工具');
        const secondUrl = Deno.env.get('E2E_CONTROLLER_SECOND_URL');
        const nextApi = secondUrl ? new ApiClient({ ...config, baseUrl: secondUrl }) : api;
        const next = await nextApi.post('/v1/messages', {
          ...request,
          model: model + '[200k]',
          tool_choice: { type: 'none' },
          messages: [...request.messages, { role: 'assistant', content: first.json.content }, {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: call.id, content: '{"port":18765}' }],
          }],
        });
        assertStatus(next, 200);
        assertAnthropicMessage(next.json, model + '[200k]');
        assertEquals(next.json.stop_reason, 'end_turn');
        assertTrue(textOf(next.json).includes('18765'), '必须使用工具结果中的真实端口');
        assertEquals(
          next.json.sider_session.conversation_id,
          first.json.sider_session.conversation_id,
        );
        return `原名和上下文标签共享工具id及检查点；跨实例=${!!secondUrl}`;
      },
    },
    {
      name: '1M标签：64-token XML分类停止序列可被客户端解析',
      async run({ api }) {
        const result = await api.postWith('/v1/messages?beta=true', {
          model: model + '[1M]',
          max_tokens: 64,
          thinking: { type: 'disabled' },
          system: classifierSystem,
          stop_sequences: ['</block>'],
          messages: [{
            role: 'user',
            content: `Analyze: Get-ChildItem C:/isolated/${crypto.randomUUID()}`,
          }],
        }, { 'anthropic-beta': 'context-1m-2025-08-07' });
        assertStatus(result, 200);
        assertAnthropicMessage(result.json, model + '[1M]');
        assertTrue(!result.json.sider_session, 'XML分类使用原生兼容后端');
        assertTrue(!toolUseOf(result.json), '分类不派发工具');
        assertTrue(/^<block>(yes|no)\b/.test(textOf(result.json).trim()), '模型返回可解析XML判定');
        assertEquals(result.json.stop_reason, 'stop_sequence');
        assertEquals(result.json.stop_sequence, '</block>');
        return '实际XML分类响应，64-token请求可用，正文停止序列生效';
      },
    },
    {
      name: '1M标签：流式无工具XML分类保留判定及对外模型名',
      async run({ api }) {
        const marker = crypto.randomUUID();
        const result = await api.sse('/v1/messages?beta=true', {
          model: model + '[1m]',
          max_tokens: 256,
          stream: true,
          thinking: { type: 'disabled' },
          system: classifierSystem,
          messages: [{ role: 'user', content: `Analyze: Get-ChildItem C:/isolated/${marker}` }],
        });
        assertEquals(result.status, 200);
        assertTrue(result.paired, 'SSE事件配对');
        assertTrue(!result.events.some((e) => e.type === 'error'), '分类请求无流内错误');
        assertEquals(
          result.events.find((e) => e.type === 'message_start')?.message?.model,
          model + '[1m]',
        );
        assertTrue(
          !result.events.some((e) => e.content_block?.type === 'tool_use'),
          '分类不派发工具',
        );
        assertTrue(/^<block>(yes|no)<\/block>/.test(result.text.trim()), '完整XML判定，不伪造允许');
        assertEquals(result.events.at(-1)?.type, 'message_stop');
        return '分类由真实兼容上游完成；XML和SSE完整，未执行任何命令';
      },
    },
  ],
};
