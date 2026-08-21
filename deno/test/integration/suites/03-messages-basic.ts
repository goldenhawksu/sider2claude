/**
 * Messages 非流式：跨厂商作答、system prompt、多轮上下文、入参形态、模型名保留。
 * 普通对话优先走 Sider；Sider 配额耗尽时应 fallback 到 DeepSeek 而不是空回复。
 */

import {
  assertAnthropicMessage,
  assertIncludes,
  assertStatus,
  assertTrue,
  backendOf,
  bailIfUpstreamLimited,
  blockTypes,
  brief,
  type Suite,
  type TestContext,
  textOf,
} from '../harness.ts';

/** 覆盖每个上游厂商各取一个代表模型。 */
const CROSS_VENDOR = [
  'claude-opus-4.8',
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-haiku-4.5',
  'claude-fable-5',
  'gpt-5.6-sol',
  'gpt-5.5',
  'gemini-3.7-flash',
  'deepseek-v4-pro',
  'grok-4.6',
  'glm-5',
  'qwen3.8-max',
  'kimi-k3',
  'llama-3.1-405b',
];

export const suite: Suite = {
  id: '03',
  title: 'Messages 非流式对话',
  cases: [
    ...CROSS_VENDOR.map((model) => ({
      name: `作答 ${model}`,
      async run({ api }: TestContext) {
        const res = await api.post('/v1/messages', {
          model,
          max_tokens: 512,
          messages: [{ role: 'user', content: '只回答一个词：中国的首都是哪里？' }],
        });
        bailIfUpstreamLimited(res, `${model} 上游限流`);
        assertStatus(res, 200);
        assertAnthropicMessage(res.json, model);
        const text = textOf(res.json);
        assertIncludes(text, '北京', `${model} 回答`);
        return `${backendOf(res.json)} stop=${res.json.stop_reason} :: ${brief(text, 30)}`;
      },
    })),
    {
      name: 'system prompt 生效',
      async run({ api, config }) {
        const res = await api.post('/v1/messages', {
          model: config.liveModel,
          max_tokens: 256,
          system: '你必须在每个回答的最开头原样加上前缀 [S2C]，然后再回答。',
          messages: [{ role: 'user', content: '中国的首都是哪里？' }],
        });
        bailIfUpstreamLimited(res, 'system prompt 用例上游限流');
        assertStatus(res, 200);
        assertIncludes(textOf(res.json), '[S2C]', 'system prompt 指定的前缀');
        return brief(textOf(res.json), 50);
      },
    },
    {
      name: '多轮上下文保持',
      async run({ api, config }) {
        const res = await api.post('/v1/messages', {
          model: config.liveModel,
          max_tokens: 256,
          messages: [
            { role: 'user', content: '记住这个数字：73854。' },
            { role: 'assistant', content: '好的，我记住了 73854。' },
            { role: 'user', content: '刚才那个数字是多少？只回答数字。' },
          ],
        });
        bailIfUpstreamLimited(res, '多轮用例上游限流');
        assertStatus(res, 200);
        assertIncludes(textOf(res.json), '73854', '跨轮记忆');
        return brief(textOf(res.json), 40);
      },
    },
    {
      name: 'content 数组形式入参',
      async run({ api, config }) {
        const res = await api.post('/v1/messages', {
          model: config.liveModel,
          max_tokens: 256,
          messages: [{
            role: 'user',
            content: [{ type: 'text', text: '只回答一个词：中国的首都是哪里？' }],
          }],
        });
        bailIfUpstreamLimited(res, 'content 数组用例上游限流');
        assertStatus(res, 200);
        assertIncludes(textOf(res.json), '北京', '回答');
        return '数组形式与字符串形式等价';
      },
    },
    {
      name: 'think 变体可用',
      async run({ api }) {
        const res = await api.post('/v1/messages', {
          model: 'claude-sonnet-4.6-think',
          max_tokens: 1024,
          messages: [{ role: 'user', content: '9.11 和 9.9 哪个大？' }],
        });
        bailIfUpstreamLimited(res, 'think 用例上游限流');
        assertStatus(res, 200);
        assertAnthropicMessage(res.json, 'claude-sonnet-4.6-think');
        return `blocks=[${blockTypes(res.json)}] :: ${brief(textOf(res.json), 40)}`;
      },
    },
    {
      name: '未知模型按家族回退且保留原名',
      async run({ api }) {
        const res = await api.post('/v1/messages', {
          model: 'totally-unknown-model-xyz',
          max_tokens: 256,
          messages: [{ role: 'user', content: '只回答一个词：中国的首都是哪里？' }],
        });
        bailIfUpstreamLimited(res, '未知模型用例上游限流');
        assertStatus(res, 200);
        // 关键：内部按家族保守映射，但对外必须原样保留客户端请求的模型名。
        assertAnthropicMessage(res.json, 'totally-unknown-model-xyz');
        assertIncludes(textOf(res.json), '北京', '回答');
        return '内部回退到 sonnet 家族，对外保留原名';
      },
    },
    {
      name: '限流模型不返回空回复',
      async run({ api }) {
        // claude-opus-4.8 在 Sider 配额耗尽时曾静默返回占位文本，这里锁定修复后的行为：
        // 要么 fallback 成功作答，要么明确报 429，绝不返回"无内容"的 200。
        const res = await api.post('/v1/messages', {
          model: 'claude-opus-4.8',
          max_tokens: 512,
          messages: [{ role: 'user', content: '只回答一个词：中国的首都是哪里？' }],
        });
        if (res.status === 429 && res.json?.error?.type === 'rate_limit_error') {
          return '上游限流，明确返回 429 rate_limit_error（非空回复）';
        }
        assertStatus(res, 200);
        const text = textOf(res.json);
        assertTrue(
          !text.includes('no text content was generated'),
          '不返回"无内容"占位文本',
        );
        assertIncludes(text, '北京', '回答');
        return `${backendOf(res.json)} 正常作答 :: ${brief(text, 30)}`;
      },
    },
  ],
};
