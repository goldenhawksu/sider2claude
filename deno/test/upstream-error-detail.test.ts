/**
 * 上游错误详情透传。
 *
 * A/B 对比（本地 DeepSeek vs 线上 GLM）暴露的问题：同一张图 GLM 接受、DeepSeek
 * 以 400 拒绝并明确说明「unsupported image ... formats: webp, png, jpeg, and gif」，
 * 但调用方最终只收到：
 *
 *     {"type":"error","error":{"message":"deepseek API error: 400 Bad Request"}}
 *
 * 原因说明在 adapter 里被丢掉了。用户看到这个错误无从下手——不知道是图片问题、
 * 参数问题还是配额问题。
 *
 * 这一条与「换上游前端无感」是同一件事的两面：能抹平的差异要抹平（见
 * upstream-capabilities.ts），**抹不平的差异必须说清楚**。上游的图片校验策略
 * 我们不该也不能代劳（转码用户的图片是越界），那就至少把它拒绝的理由原样带出去。
 */

import { AnthropicApiAdapter, AnthropicBackendError } from '../src/adapters/anthropic-adapter.ts';
import type { AnthropicRequest } from '../src/types/anthropic.ts';

function assert(condition: boolean, what: string) {
  if (!condition) throw new Error(`断言失败：${what}`);
}

function assertEquals<T>(actual: T, expected: T, what = '值') {
  if (actual !== expected) {
    throw new Error(`${what}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

function newAdapter() {
  return new AnthropicApiAdapter({
    enabled: true,
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/anthropic',
    apiKey: 'test-key',
    model: 'deepseek-v4-flash-vision-exp',
  });
}

const ASK = {
  model: 'claude-haiku-4.5',
  max_tokens: 128,
  messages: [{ role: 'user', content: 'hi' }],
} as unknown as AnthropicRequest;

async function expectError(status: number, body: string, contentType = 'application/json') {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(body, { status, headers: { 'content-type': contentType } }),
    )) as typeof fetch;
  try {
    await newAdapter().sendRequest(ASK);
    throw new Error('断言失败：期望抛出错误');
  } catch (error) {
    if (!(error instanceof AnthropicBackendError)) throw error;
    return error;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

Deno.test('上游错误：Anthropic 形状的错误体，message 必须带到调用方', async () => {
  // 这正是 DeepSeek 拒绝图片时的真实响应
  const error = await expectError(
    400,
    JSON.stringify({
      error: {
        message:
          'messages.0.content[0].image[0]: You have uploaded an unsupported image. Please make sure your image is valid and has one of the following formats: webp, png, jpeg, and gif.',
        type: 'invalid_request_error',
      },
    }),
  );

  assert(
    error.message.includes('unsupported image'),
    '上游说明必须出现在错误里——没有它，用户不知道该改什么',
  );
  assert(error.message.includes('webp, png, jpeg'), '格式要求同样要带上');
  assertEquals(error.statusCode, 400, '状态码保留');
});

Deno.test('上游错误：仍保留 provider 与状态码，便于区分是哪一层出的问题', async () => {
  const error = await expectError(
    429,
    JSON.stringify({ error: { message: 'Rate limit exceeded' } }),
  );

  assert(error.message.includes('deepseek'), '要能看出是上游而不是本服务');
  assert(error.message.includes('429'), '状态码要在消息里可见');
  assert(error.message.includes('Rate limit exceeded'), '上游原文');
  assertEquals(error.statusCode, 429, 'statusCode');
});

Deno.test('上游错误：非 JSON 错误体（网关 HTML 之类）也要带出可读片段', async () => {
  const error = await expectError(
    502,
    '<html><body>502 Bad Gateway</body></html>',
    'text/html',
  );

  assert(error.message.includes('502'), '状态码');
  assert(error.message.includes('Bad Gateway'), '原文片段——总比一句 502 有用');
});

Deno.test('上游错误：超长错误体被截断，不把整页 HTML 灌给调用方', async () => {
  const error = await expectError(500, 'x'.repeat(5000), 'text/plain');

  assert(error.message.length < 600, `错误消息应有上限，实际 ${error.message.length}`);
});

Deno.test('上游错误：错误体为空时退回状态文本，不产生空消息', async () => {
  const error = await expectError(503, '', 'text/plain');

  assert(error.message.includes('503'), '至少要有状态码');
  assert(error.message.trim().length > 10, '不能是一句空话');
});

Deno.test('上游错误：嵌套在 error.error.message 的形状也能取到', async () => {
  // 有些兼容端会多包一层
  const error = await expectError(
    400,
    JSON.stringify({ error: { error: { message: 'nested detail here' } } }),
  );

  assert(
    error.message.includes('nested detail') || error.message.includes('nested'),
    '取不到结构化字段时也该带上原始片段，不能什么都不说',
  );
});
