/**
 * 视觉输入透传。
 *
 * 背景：`sanitizeMessagesForUpstream` 会把消息的 content 数组整个压平成纯文本，
 * 目的是避免上游在 thinking 模式下要求完整的 `content[].thinking` passback
 * （见 deepseek-adapter.test.ts 的转录用例）。图片块是这个策略的附带牺牲品——
 * 它被替换成 `[image content omitted]`，于是 API 收下 200、模型却答「我没有收到
 * 图片」。**静默失败**比明确报错更糟：调用方无从得知视觉根本没生效。
 *
 * 上游 `glm-5.3-flash` 是 VLM，原生支持图文混合输入，所以这个丢弃没有必要。
 *
 * 本文件锁定的取向：
 * 1. 图片块**原样透传**，`source` 逐字段保留；
 * 2. 但只在消息**确实含图片**时才产出数组形态的 content——不含图片的消息
 *    必须维持纯字符串，否则发往上游的请求前缀逐轮变形，会打断 prompt 缓存
 *    （见 prompt-cache.test.ts，命中率 31 倍价差）；
 * 3. thinking / tool_use / tool_result 仍旧转文本，图片不是放宽它们的借口。
 */

import { AnthropicApiAdapter } from '../src/adapters/anthropic-adapter.ts';
import type { AnthropicRequest } from '../src/types/anthropic.ts';

function assertEquals<T>(actual: T, expected: T, what = '值') {
  if (actual !== expected) {
    throw new Error(`${what}：期望 ${String(expected)}，实际 ${String(actual)}`);
  }
}

function assert(condition: boolean, what: string) {
  if (!condition) {
    throw new Error(`断言失败：${what}`);
  }
}

/** 1x1 透明 PNG，够用来断言 source 是否被逐字段保留。 */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function imageBlock(data = PNG) {
  return {
    type: 'image' as const,
    source: { type: 'base64' as const, media_type: 'image/png' as const, data },
  };
}

/** 装上假的 fetch，捕获发往上游的请求体。 */
async function captureUpstream(
  request: AnthropicRequest,
): Promise<AnthropicRequest & Record<string, unknown>> {
  const originalFetch = globalThis.fetch;
  let captured: (AnthropicRequest & Record<string, unknown>) | undefined;

  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    captured = JSON.parse(init?.body as string);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: 'msg_vision_1',
          type: 'message',
          role: 'assistant',
          model: 'glm-5.3-flash',
          content: [{ type: 'text', text: '这是一张红色的图片。' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 20, output_tokens: 8 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  }) as typeof fetch;

  try {
    const adapter = new AnthropicApiAdapter({
      enabled: true,
      provider: 'deepseek',
      baseUrl: 'https://api.z.ai/api/anthropic',
      apiKey: 'test-key',
      model: 'glm-5.3-flash',
    });
    await adapter.sendRequest(request);
  } finally {
    globalThis.fetch = originalFetch;
  }

  if (!captured) throw new Error('未捕获到上游请求');
  return captured;
}

Deno.test('视觉：图片块原样透传给上游，不再被替换成占位文本', async () => {
  const body = await captureUpstream({
    model: 'claude-haiku-4.5',
    max_tokens: 128,
    messages: [{
      role: 'user',
      content: [imageBlock(), { type: 'text', text: '这张图是什么颜色？' }],
    }],
  } as unknown as AnthropicRequest);

  const content = body.messages[0].content;
  assert(Array.isArray(content), '含图片的消息应保留数组形态的 content');

  const blocks = content as Array<Record<string, any>>;
  const image = blocks.find((b) => b.type === 'image');
  assert(!!image, '图片块必须存在于发往上游的请求里');
  assertEquals(image!.source.type, 'base64', 'source.type');
  assertEquals(image!.source.media_type, 'image/png', 'source.media_type');
  assertEquals(image!.source.data, PNG, 'source.data 必须逐字节保留');

  const text = blocks.find((b) => b.type === 'text');
  assert(!!text && String(text.text).includes('什么颜色'), '同一条消息里的文本也要保留');

  const serialized = JSON.stringify(body);
  assertEquals(serialized.includes('[image content omitted]'), false, '不应再出现占位文本');
});

Deno.test('视觉：不含图片的消息仍压平成纯字符串（保住上游 prompt 缓存前缀）', async () => {
  const body = await captureUpstream({
    model: 'claude-haiku-4.5',
    max_tokens: 128,
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: '你好' }, { type: 'text', text: '请介绍一下自己' }],
    }],
  } as unknown as AnthropicRequest);

  const content = body.messages[0].content;
  assertEquals(
    typeof content,
    'string',
    '无图片时必须维持纯字符串——改成数组会让请求前缀逐轮变形，打断上游缓存',
  );
  assert(String(content).includes('你好'), '文本内容应保留');
  assert(String(content).includes('请介绍一下自己'), '多个文本块应合并');
});

Deno.test('视觉：图片与工具历史并存时，图片保留而工具轮仍转文本', async () => {
  const body = await captureUpstream({
    model: 'claude-haiku-4.5',
    max_tokens: 128,
    messages: [{
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '历史推理', signature: 'sig_1' },
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/a.png' } },
      ],
    }, {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: '已读取' }] },
        imageBlock(),
        { type: 'text', text: '这张图里有什么？' },
      ],
    }],
    tools: [{
      name: 'Read',
      description: 'read file',
      input_schema: { type: 'object', properties: { file_path: { type: 'string' } } },
    }],
  } as unknown as AnthropicRequest);

  // assistant 轮没有图片 -> 仍是纯文本转录
  const assistant = body.messages[0].content;
  assertEquals(typeof assistant, 'string', 'assistant 轮应转录为文本');
  assertEquals(String(assistant).includes('thinking'), false, 'thinking 绝不能透传');
  assert(
    String(assistant).includes('Previous assistant tool request: name=Read'),
    '工具调用应转录为约定格式',
  );

  // user 轮含图片 -> 数组形态，图片保留、tool_result 转成文本块
  const user = body.messages[1].content;
  assert(Array.isArray(user), '含图片的 user 轮应保留数组');
  const blocks = user as Array<Record<string, any>>;
  assert(blocks.some((b) => b.type === 'image'), '图片必须保留');
  assertEquals(
    blocks.some((b) => b.type === 'tool_result'),
    false,
    'tool_result 结构不得原样透传（上游会要求 thinking passback）',
  );
  const joined = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  assert(joined.includes('Previous tool result:'), 'tool_result 应转录为文本');
  assert(joined.includes('这张图里有什么'), '用户提问应保留');
});

Deno.test('视觉：多轮对话里的历史图片同样保留', async () => {
  const body = await captureUpstream({
    model: 'claude-haiku-4.5',
    max_tokens: 128,
    messages: [
      { role: 'user', content: [imageBlock(), { type: 'text', text: '这是图一' }] },
      { role: 'assistant', content: [{ type: 'text', text: '我看到了图一。' }] },
      { role: 'user', content: [imageBlock(), { type: 'text', text: '这是图二，和图一有什么区别？' }] },
    ],
  } as unknown as AnthropicRequest);

  const imageCount = body.messages
    .filter((m) => Array.isArray(m.content))
    .flatMap((m) => m.content as Array<Record<string, any>>)
    .filter((b) => b.type === 'image').length;
  assertEquals(imageCount, 2, '两轮的图片都应保留');
});

Deno.test('视觉：只有图片、没有文本的消息不会被丢弃', async () => {
  // sanitize 原本会因为「转录出的文本为空」而整条丢掉消息，
  // 纯图片消息正好命中这个分支。
  const body = await captureUpstream({
    model: 'claude-haiku-4.5',
    max_tokens: 128,
    messages: [{ role: 'user', content: [imageBlock()] }],
  } as unknown as AnthropicRequest);

  assertEquals(body.messages.length, 1, '纯图片消息不应被丢弃');
  const blocks = body.messages[0].content as Array<Record<string, any>>;
  assert(Array.isArray(blocks) && blocks.some((b) => b.type === 'image'), '图片应保留');
});
