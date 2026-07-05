import {
  normalizeAnthropicRequest,
  validateAnthropicRequest,
} from '../src/utils/request-converter.ts';
import type { AnthropicRequest } from '../src/types/anthropic.ts';

function assertEquals<T>(actual: T, expected: T) {
  if (actual !== expected) {
    throw new Error(`断言失败：期望 ${String(expected)}，实际 ${String(actual)}`);
  }
}

function assertIncludes(actual: string, expected: string) {
  if (!actual.includes(expected)) {
    throw new Error(`断言失败：期望内容包含 ${expected}，实际 ${actual}`);
  }
}

Deno.test('请求归一化：messages 内 system 提升为顶层 system', () => {
  const request = normalizeAnthropicRequest({
    model: 'claude-sonnet-4.6',
    messages: [
      { role: 'system', content: '你是一个编码助手' },
      { role: 'user', content: 'hello' },
    ],
    max_tokens: 64,
  } as unknown as AnthropicRequest);

  validateAnthropicRequest(request);

  assertEquals(request.system, '你是一个编码助手');
  assertEquals(request.messages.length, 1);
  assertEquals(request.messages[0].role, 'user');
});

Deno.test('请求归一化：OpenAI 风格 tool role 转为 Anthropic user 消息', () => {
  const request = normalizeAnthropicRequest({
    model: 'claude-sonnet-4.6',
    messages: [
      { role: 'assistant', content: '调用工具' },
      { role: 'tool', tool_call_id: 'call_1', content: 'done' },
      { role: 'user', content: '继续' },
    ],
    max_tokens: 64,
  } as unknown as AnthropicRequest);

  validateAnthropicRequest(request);

  assertEquals(request.messages[1].role, 'user');
  if (typeof request.messages[1].content !== 'string') {
    throw new Error('断言失败：期望 tool role 被转换为文本');
  }
  assertIncludes(request.messages[1].content, '[tool_result] tool_use_id=call_1');
  assertIncludes(request.messages[1].content, 'done');
});

Deno.test('请求归一化：未知 role 仍由严格校验拒绝', () => {
  const request = normalizeAnthropicRequest({
    model: 'claude-sonnet-4.6',
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'critic', content: 'bad role' },
    ],
    max_tokens: 64,
  } as unknown as AnthropicRequest);

  try {
    validateAnthropicRequest(request);
    throw new Error('断言失败：期望校验抛出错误');
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    assertEquals(error.message, 'Invalid message role. Must be "user" or "assistant"');
  }
});
