/**
 * 鉴权与错误处理。这些用例全部不依赖上游，任何失败都是本服务问题。
 */

import { assertEquals, assertStatus, assertTrue, brief, type Suite } from '../harness.ts';

const PLAIN = { 'content-type': 'application/json' };

function chatBody(model: string) {
  return { model, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] };
}

export const suite: Suite = {
  id: '10',
  title: '鉴权与错误处理',
  cases: [
    {
      name: '无 token 返回 401',
      async run({ api, config }) {
        const res = await api.post('/v1/messages', chatBody(config.liveModel), PLAIN);
        assertStatus(res, 401);
        assertEquals(res.json?.error?.type, 'authentication_error', 'error.type');
        return `HTTP 401 :: ${brief(res.json.error.message, 60)}`;
      },
    },
    {
      name: '错误 token 返回 401',
      async run({ api, config }) {
        const res = await api.post('/v1/messages', chatBody(config.liveModel), {
          ...PLAIN,
          'x-api-key': 'sk-definitely-not-a-valid-token',
        });
        assertStatus(res, 401);
        assertEquals(res.json?.error?.type, 'authentication_error', 'error.type');
        return 'HTTP 401 INVALID_TOKEN';
      },
    },
    {
      name: 'x-api-key 与 Bearer 两种鉴权都接受',
      async run({ api, config }) {
        const bearer = await api.post('/v1/messages', chatBody(config.liveModel), {
          ...PLAIN,
          authorization: `Bearer ${config.authToken}`,
        });
        assertTrue(bearer.status !== 401, `Bearer 通过鉴权（实际 ${bearer.status}）`);
        const apiKey = await api.post('/v1/messages', chatBody(config.liveModel), {
          ...PLAIN,
          'x-api-key': config.authToken,
        });
        assertTrue(apiKey.status !== 401, `x-api-key 通过鉴权（实际 ${apiKey.status}）`);
        return `Bearer=${bearer.status} x-api-key=${apiKey.status}`;
      },
    },
    {
      name: '缺 messages 返回 400',
      async run({ api, config }) {
        const res = await api.post('/v1/messages', { model: config.liveModel, max_tokens: 16 });
        assertStatus(res, 400);
        assertEquals(res.json?.type, 'error', 'type');
        assertEquals(res.json?.error?.type, 'invalid_request_error', 'error.type');
        return brief(res.json.error.message, 60);
      },
    },
    {
      name: 'messages 为空数组返回 400',
      async run({ api, config }) {
        const res = await api.post('/v1/messages', {
          model: config.liveModel,
          max_tokens: 16,
          messages: [],
        });
        assertStatus(res, 400);
        assertEquals(res.json?.error?.type, 'invalid_request_error', 'error.type');
        return brief(res.json.error.message, 60);
      },
    },
    {
      name: '畸形 JSON 返回 4xx/5xx 而非挂起',
      async run({ config }) {
        const res = await fetch(`${config.baseUrl}/v1/messages`, {
          method: 'POST',
          headers: { ...PLAIN, 'x-api-key': config.authToken },
          body: '{ 这不是合法 JSON',
          signal: AbortSignal.timeout(config.timeoutMs),
        });
        const text = await res.text();
        assertTrue(res.status >= 400, `返回错误状态（实际 ${res.status}）`);
        return `HTTP ${res.status} :: ${brief(text, 60)}`;
      },
    },
    {
      name: 'GET /v1/messages 不被当作对话请求',
      async run({ api }) {
        const res = await api.get('/v1/messages');
        assertTrue(res.status === 404 || res.status === 405, `方法不支持（实际 ${res.status}）`);
        return `HTTP ${res.status}`;
      },
    },
    {
      name: '错误响应统一为 Anthropic error 结构',
      async run({ api, config }) {
        // 三种不同来源的错误都应有相同外形：{type:'error', error:{type, message}}
        const samples = [
          await api.post('/v1/messages', { model: config.liveModel, max_tokens: 16 }),
          await api.post('/v1/messages', chatBody(config.liveModel), PLAIN),
          await api.get('/v1/models/no-such-model-xyz'),
        ];
        for (const res of samples) {
          assertTrue(res.status >= 400, '是错误响应');
          const err = res.json?.error;
          assertTrue(!!err, `响应体含 error 字段（实际 ${brief(res.text, 60)}）`);
          assertTrue(typeof err.type === 'string' && !!err.type, 'error.type 非空');
          assertTrue(typeof err.message === 'string' && !!err.message, 'error.message 非空');
        }
        return `${samples.length} 类错误外形一致`;
      },
    },
  ],
};
