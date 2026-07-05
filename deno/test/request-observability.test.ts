import type { AnthropicRequest } from '../src/types/anthropic.ts';
import {
  createRequestLogContext,
  hashAnthropicRequest,
  observeDuplicateCandidate,
  resetRequestObservabilityForTests,
  summarizeAnthropicRequest,
} from '../src/utils/request-observability.ts';

function assertEquals<T>(actual: T, expected: T) {
  if (actual !== expected) {
    throw new Error(`断言失败：期望 ${String(expected)}，实际 ${String(actual)}`);
  }
}

Deno.test('请求观测：请求指纹忽略 stream 差异以识别客户端重复候选', () => {
  const base = {
    model: 'claude-opus-4.6',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [{
      name: 'Bash',
      input_schema: { type: 'object', properties: {}, required: [] },
    }],
    max_tokens: 128,
  } as AnthropicRequest;

  const streamHash = hashAnthropicRequest({ ...base, stream: true });
  const nonStreamHash = hashAnthropicRequest({ ...base, stream: false });

  assertEquals(streamHash, nonStreamHash);
});

Deno.test('请求观测：stream true/false 重复候选只报告一次', () => {
  resetRequestObservabilityForTests();

  const hash = 'same-request';
  const first = observeDuplicateCandidate(hash, true, 1_000);
  const second = observeDuplicateCandidate(hash, false, 1_100);
  const third = observeDuplicateCandidate(hash, false, 1_200);
  const fourth = observeDuplicateCandidate(hash, true, 1_300);

  assertEquals(first.duplicate, false);
  assertEquals(second.duplicate, true);
  assertEquals(third.duplicate, false);
  assertEquals(fourth.duplicate, false);
  assertEquals(fourth.count, 4);
});

Deno.test('请求观测：摘要不包含消息正文但保留规模信息', () => {
  const summary = summarizeAnthropicRequest({
    model: 'claude-sonnet-4.6',
    system: 'secret system text',
    messages: [{ role: 'user', content: 'secret user text' }],
    max_tokens: 64,
    stream: true,
  });

  assertEquals(summary.model, 'claude-sonnet-4.6');
  assertEquals(summary.messages, 1);
  assertEquals(summary.tools, 0);
  assertEquals(summary.stream, true);
  assertEquals(summary.hasSystem, true);
  assertEquals(summary.maxTokens, 64);
});

Deno.test('请求观测：外部 request id 会被清洗和截断', () => {
  const context = createRequestLogContext({
    model: 'claude-sonnet-4.6',
    messages: [{ role: 'user', content: 'hello' }],
  }, `abc\r\n${'x'.repeat(120)}`);

  assertEquals(context.requestId.includes('\r'), false);
  assertEquals(context.requestId.includes('\n'), false);
  assertEquals(context.requestId.length, 80);
});

Deno.test('request observability keeps duplicate candidates after a 30s stream', () => {
  resetRequestObservabilityForTests();

  const hash = 'slow-stream-request';
  const first = observeDuplicateCandidate(hash, true, 1_000);
  const second = observeDuplicateCandidate(hash, false, 32_000);

  assertEquals(first.duplicate, false);
  assertEquals(second.duplicate, true);
  assertEquals(second.ageMs, 31_000);
});
