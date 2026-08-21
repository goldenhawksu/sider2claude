// deno-lint-ignore-file no-explicit-any -- 集成测试要读取形状不固定的上游 JSON，any 是恰当选择。
/**
 * Gemini 协议兼容端点：:generateContent 与 :streamGenerateContent。
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

const MODEL = 'gemini-3.7-flash';

export const suite: Suite = {
  id: '08',
  title: 'Gemini 协议兼容',
  cases: [
    {
      name: ':generateContent 基础作答',
      async run({ api }) {
        const res = await api.post(`/v1beta/models/${MODEL}:generateContent`, {
          contents: [{ role: 'user', parts: [{ text: '只回答一个词：中国的首都是哪里？' }] }],
        });
        bailIfUpstreamLimited(res, 'generateContent 上游限流');
        assertStatus(res, 200);
        const candidate = res.json?.candidates?.[0];
        assertTrue(!!candidate, 'candidates 非空');
        assertEquals(candidate.content?.role, 'model', 'content.role');
        assertEquals(candidate.finishReason, 'STOP', 'finishReason');
        const text = candidate.content?.parts?.map((p: any) => p.text).join('') ?? '';
        assertIncludes(text, '北京', '回答');
        assertTrue(
          typeof res.json?.usageMetadata?.totalTokenCount === 'number',
          'usageMetadata.totalTokenCount',
        );
        return `finishReason=STOP tokens=${res.json.usageMetadata.totalTokenCount} :: ${brief(text, 24)}`;
      },
    },
    {
      name: ':generateContent 支持 systemInstruction',
      async run({ api }) {
        const res = await api.post(`/v1beta/models/${MODEL}:generateContent`, {
          systemInstruction: { parts: [{ text: '你必须在回答最开头加上前缀 [S2C]。' }] },
          contents: [{ role: 'user', parts: [{ text: '中国的首都是哪里？' }] }],
        });
        bailIfUpstreamLimited(res, 'systemInstruction 用例上游限流');
        assertStatus(res, 200);
        const text = res.json.candidates[0].content.parts.map((p: any) => p.text).join('');
        assertIncludes(text, '[S2C]', 'systemInstruction 指定前缀');
        return brief(text, 50);
      },
    },
    {
      name: ':generateContent 多轮上下文',
      async run({ api }) {
        const res = await api.post(`/v1beta/models/${MODEL}:generateContent`, {
          contents: [
            { role: 'user', parts: [{ text: '记住数字 62317。' }] },
            { role: 'model', parts: [{ text: '好的，我记住了 62317。' }] },
            { role: 'user', parts: [{ text: '刚才的数字是多少？只回答数字。' }] },
          ],
        });
        bailIfUpstreamLimited(res, 'Gemini 多轮用例上游限流');
        assertStatus(res, 200);
        const text = res.json.candidates[0].content.parts.map((p: any) => p.text).join('');
        assertIncludes(text, '62317', '跨轮记忆');
        return brief(text, 40);
      },
    },
    {
      name: ':streamGenerateContent 流式',
      async run({ api }) {
        const res = await api.sse(`/v1beta/models/${MODEL}:streamGenerateContent`, {
          contents: [{ role: 'user', parts: [{ text: '数到3' }] }],
        });
        assertEquals(res.status, 200, 'HTTP 状态');
        const withCandidates = res.events.filter((e) => Array.isArray(e.candidates));
        assertTrue(withCandidates.length > 0, '流内有 candidates 事件');
        const text = withCandidates
          .map((e) => e.candidates[0]?.content?.parts?.map((p: any) => p.text).join('') ?? '')
          .join('');
        assertTrue(text.length > 0, '流式累计文本非空');
        return `事件=${res.events.length} 含candidates=${withCandidates.length} :: ${brief(text, 24)}`;
      },
    },
  ],
};
