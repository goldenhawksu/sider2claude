import { convertAnthropicToSiderSync } from '../src/utils/request-converter.ts';
import { restoreToolUseFromText } from '../src/utils/textual-tool-use.ts';
import type { AnthropicRequest } from '../src/types/anthropic.ts';
import { createAccumulatorCallbacks, streamSiderSSE } from '../src/utils/sse-line-reader.ts';
import { SiderClient } from '../src/utils/sider-client.ts';
import { controllerHandlesRequest } from '../src/utils/sider-controller.ts';

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`期望${JSON.stringify(expected)}，实际${JSON.stringify(actual)}`);
  }
}
const request: AnthropicRequest = {
  model: 'claude-opus-5.5',
  max_tokens: 1024,
  tools: [{
    name: 'Read',
    input_schema: {
      type: 'object',
      properties: { file_path: { type: 'string' } },
      required: ['file_path'],
    },
  }],
  messages: [{
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: 'probe_read',
      is_error: true,
      content: '读取失败：端口8080',
    }],
  }],
};

Deno.test('Controller默认不接管流式请求；实验开关可显式启用', () => {
  const previousController = Deno.env.get('SIDER_CONTROLLER');
  const previousStreaming = Deno.env.get('SIDER_CONTROLLER_STREAMING');
  try {
    Deno.env.set('SIDER_CONTROLLER', 'true');
    Deno.env.delete('SIDER_CONTROLLER_STREAMING');
    equal(controllerHandlesRequest({ ...request, stream: false }), true);
    equal(controllerHandlesRequest({ ...request, stream: true }), false);
    Deno.env.set('SIDER_CONTROLLER_STREAMING', 'true');
    equal(controllerHandlesRequest({ ...request, stream: true }), true);
  } finally {
    if (previousController === undefined) Deno.env.delete('SIDER_CONTROLLER');
    else Deno.env.set('SIDER_CONTROLLER', previousController);
    if (previousStreaming === undefined) Deno.env.delete('SIDER_CONTROLLER_STREAMING');
    else Deno.env.set('SIDER_CONTROLLER_STREAMING', previousStreaming);
  }
});

Deno.test('Sider真实cid续轮完整保留纯工具结果及错误标记', () => {
  const text = convertAnthropicToSiderSync(request, 'probe-real-cid').multi_content[0].text;
  equal(text.includes('读取失败：端口8080'), true);
  equal(text.includes('tool_use_id=probe_read'), true);
  equal(text.includes('is_error=true'), true);
});
Deno.test('文本还原不允许调用本次未声明工具', () => {
  const result = restoreToolUseFromText(
    '[tool_use:Unknown] id=call_1 input={"command":"echo x"}',
    request,
  );
  equal(result.toolUseCount, 0);
  equal(result.unparsedCount, 1);
});
Deno.test('文本还原按schema拒绝错误类型和缺失必填参数', () => {
  for (const input of ['{"file_path":123}', '{}']) {
    const result = restoreToolUseFromText(`[tool_use:Read] id=call_1 input=${input}`, request);
    equal(result.toolUseCount, 0);
    equal(result.unparsedCount, 1);
  }
});
Deno.test('新版Sider统一工具事件按id合并并保留搜索结果', async () => {
  const events = ['start', 'finish'].map((status) => ({
    code: 0,
    msg: 'ok',
    data: {
      type: 'tool_call',
      model: request.model,
      tool_call: {
        id: 'native_1',
        name: 'search',
        status,
        search: { search_snippets: status === 'finish' ? { title: '来源' } : null },
      },
    },
  }));
  const { callbacks, result } = createAccumulatorCallbacks();
  await streamSiderSSE(
    new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')),
    callbacks,
  );
  equal(result.toolResults?.length, 1);
  equal(result.toolResults?.[0].status, 'finish');
  equal(result.toolResults?.[0].result.search.search_snippets.title, '来源');
});
Deno.test('Sider HTTP400的603正文保持输入过长分类', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ code: 603, msg: 'Too many words in the query.' }), {
          status: 400,
        }),
      )) as typeof fetch;
    let error: any;
    try {
      await new SiderClient().chat(convertAnthropicToSiderSync(request), 'test');
    } catch (e) {
      error = e;
    }
    equal(error?.siderCode, 603);
    equal(error?.statusCode, 413);
  } finally {
    globalThis.fetch = original;
  }
});
