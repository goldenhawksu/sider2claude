/**
 * OpenAI 协议兼容端点：/v1/chat/completions（含流式）与 /v1/responses。
 * 这两个端点走同一套混合路由，因此也间接验证 fallback 对协议层透明。
 */

import {
  assertEquals,
  assertIncludes,
  assertStatus,
  assertTrue,
  bailIfUpstreamLimited,
  brief,
  type Suite,
} from '../harness.ts';

export const suite: Suite = {
  id: '07',
  title: 'OpenAI 协议兼容',
  cases: [
    {
      name: 'POST /v1/chat/completions 非流式',
      async run({ api, config }) {
        const res = await api.post('/v1/chat/completions', {
          model: config.liveModel,
          max_tokens: 256,
          messages: [{ role: 'user', content: '只回答一个词：中国的首都是哪里？' }],
        });
        bailIfUpstreamLimited(res, 'chat/completions 上游限流');
        assertStatus(res, 200);
        assertEquals(res.json?.object, 'chat.completion', 'object');
        const choice = res.json?.choices?.[0];
        assertTrue(!!choice, 'choices 非空');
        assertEquals(choice.message?.role, 'assistant', 'message.role');
        assertTrue(!!choice.finish_reason, 'finish_reason 非空');
        assertIncludes(choice.message?.content ?? '', '北京', '回答');
        assertTrue(typeof res.json?.usage?.total_tokens === 'number', 'usage.total_tokens');
        return `finish=${choice.finish_reason} :: ${brief(choice.message.content, 30)}`;
      },
    },
    {
      name: 'chat/completions 流式（chunk + [DONE]）',
      async run({ api, config }) {
        const res = await api.sse('/v1/chat/completions', {
          model: config.liveModel,
          max_tokens: 256,
          stream: true,
          messages: [{ role: 'user', content: '数到3' }],
        });
        assertEquals(res.status, 200, 'HTTP 状态');
        const chunks = res.events.filter((e) => e.object === 'chat.completion.chunk');
        assertTrue(chunks.length > 0, '有 chat.completion.chunk 事件');
        assertTrue(res.raw.includes('[DONE]'), '以 [DONE] 结束');
        assertTrue(!!chunks[0].choices?.[0]?.delta, 'chunk 带 delta');
        return `chunk=${chunks.length} 以 [DONE] 收尾`;
      },
    },
    {
      name: 'chat/completions 支持 system 角色',
      async run({ api, config }) {
        const res = await api.post('/v1/chat/completions', {
          model: config.liveModel,
          max_tokens: 256,
          messages: [
            { role: 'system', content: '你必须在回答最开头加上前缀 [S2C]。' },
            { role: 'user', content: '中国的首都是哪里？' },
          ],
        });
        bailIfUpstreamLimited(res, 'chat/completions system 用例上游限流');
        assertStatus(res, 200);
        assertIncludes(res.json.choices[0].message.content, '[S2C]', 'system 指定前缀');
        return brief(res.json.choices[0].message.content, 50);
      },
    },
    {
      name: 'chat/completions 多轮上下文',
      async run({ api, config }) {
        const res = await api.post('/v1/chat/completions', {
          model: config.liveModel,
          max_tokens: 256,
          messages: [
            { role: 'user', content: '记住数字 51423。' },
            { role: 'assistant', content: '好的，我记住了 51423。' },
            { role: 'user', content: '刚才的数字是多少？只回答数字。' },
          ],
        });
        bailIfUpstreamLimited(res, 'chat/completions 多轮用例上游限流');
        assertStatus(res, 200);
        assertIncludes(res.json.choices[0].message.content, '51423', '跨轮记忆');
        return brief(res.json.choices[0].message.content, 40);
      },
    },
    {
      name: 'POST /v1/responses',
      async run({ api, config }) {
        const res = await api.post('/v1/responses', {
          model: config.liveModel,
          input: '只回答一个词：中国的首都是哪里？',
        });
        bailIfUpstreamLimited(res, 'responses 上游限流');
        assertStatus(res, 200);
        assertEquals(res.json?.object, 'response', 'object');
        assertEquals(res.json?.status, 'completed', 'status');
        assertIncludes(JSON.stringify(res.json?.output ?? []), '北京', 'output 内容');
        return `status=${res.json.status} output 段数=${(res.json.output ?? []).length}`;
      },
    },
  ],
};
