/**
 * Legacy /v1/complete 与 count_tokens。
 *
 * complete 端点直连 Sider、不走 RouterEngine，因此上游限流时无法 fallback，
 * 但必须返回带正确状态码的错误，而不是 200 + 空 completion。
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
  id: '09',
  title: 'Legacy complete 与 count_tokens',
  cases: [
    {
      name: 'POST /v1/complete 基础作答',
      async run({ api, config }) {
        const res = await api.post('/v1/complete', {
          model: config.liveModel,
          prompt: '\n\nHuman: 只回答一个词：中国的首都是哪里？\n\nAssistant:',
          max_tokens_to_sample: 128,
        });
        bailIfUpstreamLimited(res, 'complete 上游限流');
        assertStatus(res, 200);
        assertEquals(res.json?.type, 'completion', 'type');
        assertTrue(!!res.json?.stop_reason, 'stop_reason 非空');
        assertIncludes(res.json?.completion ?? '', '北京', 'completion 内容');
        return `stop=${res.json.stop_reason} :: ${brief(res.json.completion, 30)}`;
      },
    },
    {
      name: 'complete 上游限流返回 429 而非空 completion',
      async run({ api }) {
        const res = await api.post('/v1/complete', {
          model: 'claude-opus-4.8',
          prompt: '\n\nHuman: 你好\n\nAssistant:',
          max_tokens_to_sample: 64,
        });
        if (res.status === 200) {
          // 本轮有配额：至少要保证不是空 completion。
          assertTrue((res.json?.completion ?? '').length > 0, 'completion 非空');
          return '本轮有配额，正常返回非空 completion';
        }
        assertStatus(res, 429);
        assertEquals(res.json?.type, 'error', 'type');
        assertEquals(res.json?.error?.type, 'rate_limit_error', 'error.type');
        assertTrue((res.json?.error?.message ?? '').length > 0, 'error.message 非空');
        return `HTTP 429 rate_limit_error :: ${brief(res.json.error.message, 60)}`;
      },
    },
    {
      name: 'complete 缺 prompt 返回 400',
      async run({ api, config }) {
        const res = await api.post('/v1/complete', { model: config.liveModel });
        assertStatus(res, 400);
        assertEquals(res.json?.error?.type, 'invalid_request_error', 'error.type');
        return `HTTP 400 :: ${brief(res.json.error.message, 60)}`;
      },
    },
    {
      name: 'count_tokens 返回数字',
      async run({ api, config }) {
        const res = await api.post('/v1/messages/count_tokens', {
          model: config.liveModel,
          messages: [{ role: 'user', content: 'Hello, world! 这是一个测试。' }],
        });
        assertStatus(res, 200);
        assertTrue(typeof res.json?.input_tokens === 'number', 'input_tokens 是数字');
        assertTrue(res.json.input_tokens > 0, 'input_tokens 为正');
        return `input_tokens=${res.json.input_tokens}`;
      },
    },
    {
      name: 'count_tokens 随输入长度单调增长',
      async run({ api, config }) {
        const short = await api.post('/v1/messages/count_tokens', {
          model: config.liveModel,
          messages: [{ role: 'user', content: 'hi' }],
        });
        const long = await api.post('/v1/messages/count_tokens', {
          model: config.liveModel,
          messages: [{ role: 'user', content: 'hi '.repeat(500) }],
        });
        assertStatus(short, 200);
        assertStatus(long, 200);
        assertTrue(long.json.input_tokens > short.json.input_tokens, '长输入 token 更多');
        return `短=${short.json.input_tokens} 长=${long.json.input_tokens}`;
      },
    },
    {
      name: 'count_tokens 缺 messages 返回 400',
      async run({ api, config }) {
        const res = await api.post('/v1/messages/count_tokens', { model: config.liveModel });
        assertStatus(res, 400);
        return `HTTP 400 :: ${brief(res.json?.error?.message ?? '', 60)}`;
      },
    },
  ],
};
