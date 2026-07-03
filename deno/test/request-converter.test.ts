import { convertAnthropicToSiderSync } from '../src/utils/request-converter.ts';
import type { AnthropicRequest } from '../src/types/anthropic.ts';

const LEGACY_OPENAI_MESSAGE_FORMAT_ENV = 'SIDER_USE_OPENAI_MESSAGE_FORMAT';
const LEGACY_GEMINI_NATIVE_MESSAGE_FORMAT_ENV = 'SIDER_USE_GEMINI_NATIVE_MESSAGE_FORMAT';

function assertEquals<T>(actual: T, expected: T) {
  if (actual !== expected) {
    throw new Error(`断言失败：期望 ${String(expected)}，实际 ${String(actual)}`);
  }
}

function assertIncludes(actual: string, expected: string) {
  if (!actual.includes(expected)) {
    throw new Error(`断言失败：期望文本包含 ${expected}，实际为 ${actual}`);
  }
}

function withLegacyMessageFormatEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const keys = [LEGACY_OPENAI_MESSAGE_FORMAT_ENV, LEGACY_GEMINI_NATIVE_MESSAGE_FORMAT_ENV];
  const previous = new Map<string, string | undefined>();

  for (const key of keys) {
    previous.set(key, Deno.env.get(key));
    const value = vars[key];
    if (value === undefined) {
      Deno.env.delete(key);
    } else {
      Deno.env.set(key, value);
    }
  }

  try {
    fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        Deno.env.delete(key);
      } else {
        Deno.env.set(key, value);
      }
    }
  }
}

function multiTurnRequest(): AnthropicRequest {
  return {
    model: 'claude-sonnet-4.6',
    system: '回答必须遵守用户给出的上下文。',
    messages: [{
      role: 'user',
      content: 'Remember this exact code word for the next turn: ULTRAMARINE-729.',
    }, {
      role: 'assistant',
      content: 'I will remember ULTRAMARINE-729.',
    }, {
      role: 'user',
      content: 'What exact code word did I give you? Reply with only the code word.',
    }],
    max_tokens: 64,
  };
}

Deno.test('Sider 转换：没有真实 cid 的多轮历史固定按 transcript 文本内联', () => {
  const siderRequest = convertAnthropicToSiderSync(
    multiTurnRequest(),
    'continuous-conversation',
  );

  assertEquals(siderRequest.cid, '');
  const text = siderRequest.multi_content[0].text;
  assertIncludes(text, 'System: 回答必须遵守用户给出的上下文。');
  assertIncludes(text, 'User: Remember this exact code word');
  assertIncludes(text, 'Assistant: I will remember ULTRAMARINE-729.');
  assertIncludes(text, 'User: What exact code word did I give you?');
  assertIncludes(text, 'Assistant:');
});

Deno.test('Sider 转换：真实 cid 仍只发送当前输入，避免重复历史', () => {
  const siderRequest = convertAnthropicToSiderSync(multiTurnRequest(), 'real-sider-cid');

  assertEquals(siderRequest.cid, 'real-sider-cid');
  assertEquals(
    siderRequest.multi_content[0].text,
    'What exact code word did I give you? Reply with only the code word.',
  );
});

Deno.test('Sider 转换：旧 OpenAI/Gemini 环境变量不再改变内部 transcript 格式', () => {
  withLegacyMessageFormatEnv({
    [LEGACY_OPENAI_MESSAGE_FORMAT_ENV]: 'true',
    [LEGACY_GEMINI_NATIVE_MESSAGE_FORMAT_ENV]: 'true',
  }, () => {
    const siderRequest = convertAnthropicToSiderSync(
      multiTurnRequest(),
      'continuous-conversation',
    );

    const text = siderRequest.multi_content[0].text;
    assertIncludes(text, 'System: 回答必须遵守用户给出的上下文。');
    assertIncludes(text, 'User: Remember this exact code word');
    assertIncludes(text, 'Assistant: I will remember ULTRAMARINE-729.');
  });
});
