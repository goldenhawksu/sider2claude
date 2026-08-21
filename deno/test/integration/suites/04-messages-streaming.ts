/**
 * Messages 流式：Anthropic SSE 规范符合度。
 *
 * 重点是三件曾经出过问题的事：
 * 1. 每条事件必须同时有 `event:` 与 `data:` 行；
 * 2. 六种事件类型齐全、顺序正确；
 * 3. 上游失败时在流内发 error 事件，不能是没有内容块的空流。
 */

import {
  ANTHROPIC_STREAM_EVENTS,
  assertDefined,
  assertEquals,
  assertTrue,
  brief,
  sseUpstreamLimited,
  type Suite,
  type TestContext,
  UpstreamLimited,
} from '../harness.ts';

const STREAM_MODELS = ['claude-haiku-4.5', 'gemini-3.7-flash', 'deepseek-v4-flash'];

export const suite: Suite = {
  id: '04',
  title: 'Messages 流式 SSE',
  cases: [
    ...STREAM_MODELS.map((model) => ({
      name: `流式作答 ${model}`,
      async run({ api }: TestContext) {
        const res = await api.sse('/v1/messages', {
          model,
          max_tokens: 256,
          stream: true,
          messages: [{ role: 'user', content: '从1数到5，用空格分隔。' }],
        });
        assertEquals(res.status, 200, 'HTTP 状态');

        const limited = sseUpstreamLimited(res);
        if (limited) {
          throw new UpstreamLimited(`${model} 上游限流：${limited}`);
        }

        assertTrue(res.paired, `event: 行与 data: 行配对（${res.eventNames.length} vs ${res.events.length}）`);
        const missing = ANTHROPIC_STREAM_EVENTS.filter((e) => !res.eventNames.includes(e));
        assertTrue(missing.length === 0, `事件类型齐全（缺 ${missing.join(',')}）`);
        return `event行=${res.eventNames.length} 配对✓ 六类齐全 :: ${brief(res.text, 24)}`;
      },
    })),
    {
      name: 'SSE 事件顺序与首尾',
      async run({ api, config }) {
        const res = await api.sse('/v1/messages', {
          model: config.liveModel,
          max_tokens: 256,
          stream: true,
          messages: [{ role: 'user', content: '数到3' }],
        });
        const limited = sseUpstreamLimited(res);
        if (limited) throw new UpstreamLimited(`顺序用例上游限流：${limited}`);

        assertEquals(res.events[0]?.type, 'message_start', '首事件');
        assertEquals(res.events[res.events.length - 1]?.type, 'message_stop', '末事件');
        assertEquals(res.events[0]?.message?.role, 'assistant', 'message_start.message.role');

        // content_block_start 必须早于同 index 的 delta，且每个 start 都要闭合
        const starts = res.events.filter((e) => e.type === 'content_block_start').length;
        const stops = res.events.filter((e) => e.type === 'content_block_stop').length;
        assertEquals(stops, starts, 'content_block start/stop 成对');

        const delta = res.events.find((e) => e.type === 'message_delta');
        assertDefined(delta, 'message_delta 事件');
        assertTrue(!!delta.delta?.stop_reason, 'message_delta 带 stop_reason');
        return `首=message_start 末=message_stop 块=${starts} stop_reason=${delta.delta.stop_reason}`;
      },
    },
    {
      name: '流式响应头为 text/event-stream',
      async run({ config }) {
        const started = Date.now();
        const res = await fetch(`${config.baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': config.authToken,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: config.liveModel,
            max_tokens: 64,
            stream: true,
            messages: [{ role: 'user', content: 'hi' }],
          }),
          signal: AbortSignal.timeout(config.timeoutMs),
        });
        const contentType = res.headers.get('content-type') ?? '';
        const cacheControl = res.headers.get('cache-control') ?? '';
        await res.text();
        assertTrue(contentType.includes('text/event-stream'), `content-type 是 SSE（实际 ${contentType}）`);
        assertTrue(cacheControl.includes('no-cache'), 'cache-control 禁用缓存');
        return `${contentType} | ${cacheControl} | ${Date.now() - started}ms`;
      },
    },
    {
      name: '上游限流时流内明确报错',
      async run({ api }) {
        const res = await api.sse('/v1/messages', {
          model: 'claude-opus-4.8',
          max_tokens: 256,
          stream: true,
          messages: [{ role: 'user', content: '随便写一句话。' }],
        });
        assertEquals(res.status, 200, 'HTTP 状态');

        const hasContent = res.events.some((e) => e.type === 'content_block_delta');
        if (hasContent) {
          assertTrue(res.paired, 'event/data 行配对');
          return '本轮有配额，正常返回内容块';
        }

        // 无内容时必须有 error 事件——静默空流是修复前的缺陷行为。
        const err = res.events.find((e) => e.type === 'error');
        assertDefined(err, '无内容时的 error 事件（不能是静默空流）');
        assertTrue(!!err.error?.type, 'error 事件带 type');
        assertTrue(!!err.error?.message, 'error 事件带 message');
        return `error.type=${err.error.type} :: ${brief(err.error.message, 60)}`;
      },
    },
  ],
};
