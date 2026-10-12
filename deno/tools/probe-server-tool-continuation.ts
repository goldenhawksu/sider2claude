/**
 * 探测 Anthropic 兼容上游的服务端 webReader 是否在结果后继续生成最终文本。
 * 只输出事件类型、工具名、结束原因和短文本预览，不输出凭证或完整网页正文。
 */

import { getEnv } from '../src/utils/env.ts';
import { AnthropicApiAdapter } from '../src/adapters/anthropic-adapter.ts';
import type { AnthropicTool } from '../src/types/anthropic.ts';

const baseUrl = getEnv('DEEPSEEK_BASE_URL').replace(/\/+$/, '');
const apiKey = getEnv('DEEPSEEK_API_KEY');
const model = getEnv('DEEPSEEK_MODEL', 'glm-5.3-flash');
if (!baseUrl || !apiKey) throw new Error('缺少 DEEPSEEK_BASE_URL 或 DEEPSEEK_API_KEY');

const url = Deno.args[0] ||
  'https://raw.githubusercontent.com/goldenhawksu/sider2claude/main/docs/%E5%BC%80%E5%8F%91%E6%B5%8B%E8%AF%95%E5%8F%91%E5%B8%83SOP.md';
const mode = Deno.args[1] || 'raw';
const includeClientTools = mode !== 'no-tools';
const preferClientTool = mode === 'prefer-client';
const clientTools: AnthropicTool[] = [{
  name: 'mcp__webReader__read',
  description: 'Read a public URL and return Markdown.',
  input_schema: {
    type: 'object',
    properties: { url: { type: 'string' } },
    required: ['url'],
  },
}, {
  name: 'WebFetch',
  description: 'Fetch a public URL.',
  input_schema: {
    type: 'object',
    properties: { url: { type: 'string' }, prompt: { type: 'string' } },
    required: ['url', 'prompt'],
  },
}];
const prompt =
  `请使用内置webReader读取这个URL：${url}。无论读取成功还是失败，都必须在工具结果之后继续输出一句最终结论。`;

if (mode === 'adapter') {
  const adapter = new AnthropicApiAdapter({
    enabled: true,
    provider: 'anthropic-compatible',
    baseUrl,
    apiKey,
    model,
  });
  const result = await adapter.sendRequest({
    model: 'claude-sonnet-5.5',
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
    tools: clientTools,
  });
  console.log(JSON.stringify({
    mode,
    stopReason: result.stop_reason,
    blocks: result.content.map((block) => ({
      type: block.type,
      name: block.type === 'tool_use' ? block.name : undefined,
    })),
  }));
  Deno.exit(result.content.some((block) => block.type === 'tool_use') ? 0 : 3);
}

const response = await fetch(`${baseUrl}/v1/messages`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
    'anthropic-version': '2023-06-01',
  },
  body: JSON.stringify({
    model,
    max_tokens: 2048,
    stream: true,
    ...(preferClientTool
      ? {
        system:
          'When a declared client web tool can handle the request, do not use the server-side built-in webReader. Emit a structured tool_use for mcp__webReader__read and let the client execute it.',
      }
      : {}),
    ...(includeClientTools ? { tools: clientTools } : {}),
    messages: [{
      role: 'user',
      content: prompt,
    }],
  }),
});

if (!response.ok) {
  const detail = (await response.text()).replace(/\s+/g, ' ').slice(0, 300);
  throw new Error(`上游返回${response.status}：${detail}`);
}

const raw = await response.text();
const starts: Array<{ index?: number; type?: string; name?: string }> = [];
const texts: string[] = [];
let stopReason: unknown;
let messageStop = false;
for (const line of raw.split(/\r?\n/)) {
  if (!line.startsWith('data:')) continue;
  const data = line.slice(5).trim();
  if (!data || data === '[DONE]') continue;
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(data) as Record<string, unknown>;
  } catch {
    continue;
  }
  if (event.type === 'content_block_start') {
    const block = event.content_block as Record<string, unknown> | undefined;
    starts.push({
      index: typeof event.index === 'number' ? event.index : undefined,
      type: typeof block?.type === 'string' ? block.type : undefined,
      name: typeof block?.name === 'string' ? block.name : undefined,
    });
  }
  if (event.type === 'content_block_delta') {
    const delta = event.delta as Record<string, unknown> | undefined;
    if (typeof delta?.text === 'string') texts.push(delta.text);
  }
  if (event.type === 'message_delta') {
    stopReason = (event.delta as Record<string, unknown> | undefined)?.stop_reason;
  }
  if (event.type === 'message_stop') messageStop = true;
}

const text = texts.join('');
console.log(JSON.stringify({
  model,
  includeClientTools,
  preferClientTool,
  starts,
  stopReason,
  messageStop,
  textChars: text.length,
  textPreview: text.replace(/\s+/g, ' ').slice(0, 500),
}));
