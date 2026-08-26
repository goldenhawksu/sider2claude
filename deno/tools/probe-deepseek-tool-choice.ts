/**
 * 一次性侦察：DeepSeek 的 Anthropic 兼容端到底接不接受强制 tool_choice。
 *
 * 仓库里当前的做法是 `delete upstreamRequest.tool_choice` + 往最后一条 user 消息
 * 尾部注入一段文字来"保留意图"。注释说这是因为上游会 400。但尾部注入正是打断
 * 上游 prefix 缓存的那类改动（见 probe-deepseek-cache 的 A/B），所以值得实测确认
 * 这条绕行是不是还需要——不能只信文档，也不能只信旧注释。
 */

import { loadBackendConfig } from '../src/config/backends.ts';

const { baseUrl, apiKey, model } = loadBackendConfig().deepseek;

const TOOL = {
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  input_schema: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
};

async function attempt(label: string, toolChoice: unknown): Promise<void> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 128,
      tools: [TOOL],
      ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
      messages: [{ role: 'user', content: 'What should I wear today in Shanghai?' }],
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    console.log(`[${label}] HTTP ${response.status} -> ${text.slice(0, 300)}`);
    return;
  }

  const data = JSON.parse(text) as {
    stop_reason?: string;
    content?: Array<{ type: string; name?: string }>;
  };
  const blocks = (data.content ?? []).map((b) => b.type === 'tool_use' ? `tool_use:${b.name}` : b.type);
  console.log(`[${label}] HTTP 200 stop_reason=${data.stop_reason} content=[${blocks.join(', ')}]`);
}

console.log(`baseUrl=${baseUrl} model=${model}`);
await attempt('no tool_choice', undefined);
await attempt('tool_choice=auto', { type: 'auto' });
await attempt('tool_choice=any', { type: 'any' });
await attempt('tool_choice=tool(get_weather)', { type: 'tool', name: 'get_weather' });
await attempt('tool_choice=none', { type: 'none' });
