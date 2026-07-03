import { convertAnthropicToSiderSync } from '../src/utils/request-converter.ts';
import type { AnthropicRequest } from '../src/types/anthropic.ts';

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

Deno.test('Sider 转换：无真实 cid 的多轮 Anthropic 历史会内联到请求文本', () => {
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
