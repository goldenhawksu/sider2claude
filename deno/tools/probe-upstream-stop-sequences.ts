/**
 * 一次性侦察：上游对 `stop_sequences` 的真实行为。
 *
 * 测评实测到两件事：Sider 通道完全不截断（"1 2 3 4 5" 原样输出）；DeepSeek 通道
 * 截断了，但截的是 thinking 块，且 `stop_reason` 仍报 `end_turn`、`stop_sequence`
 * 字段缺失——两者都不符合 Anthropic 规范（命中时应为 `stop_reason:"stop_sequence"`
 * 且带上命中的那个序列）。
 *
 * 本脚本回答的是：这是上游没按规范返回，还是我们在转换时丢了字段？答案决定
 * 修复该放在哪一层。
 */

import { loadBackendConfig } from '../src/config/backends.ts';

const { baseUrl, apiKey, model } = loadBackendConfig().deepseek;

async function attempt(
  label: string,
  body: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens: 300, ...body }),
  });

  const text = await response.text();
  if (!response.ok) {
    console.log(`[${label}] HTTP ${response.status} -> ${text.slice(0, 200)}`);
    return;
  }

  const data = JSON.parse(text) as {
    stop_reason?: string;
    stop_sequence?: string;
    content?: Array<{ type: string; text?: string; thinking?: string }>;
  };
  const blocks = (data.content ?? []).map((b) => b.type).join(',');
  const out = (data.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
  console.log(
    `[${label}]\n` +
      `   stop_reason=${data.stop_reason}  stop_sequence=${JSON.stringify(data.stop_sequence)}\n` +
      `   blocks=[${blocks}]  正文=${JSON.stringify(out.slice(0, 60))}`,
  );
}

console.log(`baseUrl=${baseUrl} model=${model}\n`);

const PROMPT = '只输出这几个字符，不要说别的：1 2 3 4 5';

await attempt('无 stop_sequences（对照）', {
  messages: [{ role: 'user', content: PROMPT }],
});

await attempt('stop_sequences=["3"]', {
  stop_sequences: ['3'],
  messages: [{ role: 'user', content: PROMPT }],
});

await attempt('stop_sequences=["END"] 且要求模型输出 END', {
  stop_sequences: ['END'],
  messages: [{ role: 'user', content: '请输出：AAA END BBB' }],
});

await attempt('stop_sequences 多个候选', {
  stop_sequences: ['4', '5'],
  messages: [{ role: 'user', content: PROMPT }],
});
