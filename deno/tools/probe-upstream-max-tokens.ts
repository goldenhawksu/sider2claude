/**
 * 一次性侦察：`max_tokens` 到底能不能兑现。
 *
 * 测评实测到两个问题：
 * 1. **Sider 通道完全忽略 max_tokens** —— `max_tokens=10` 实得 74 tokens / 294 字符，
 *    `stop_reason` 还报 `end_turn`。
 * 2. **DeepSeek 通道遵守 max_tokens，但 thinking 会吃光预算** —— 小预算下返回
 *    `content=[thinking]`、正文 0 字，`stop_reason=max_tokens`。调用方拿到一个
 *    「成功但没有内容」的响应。
 *
 * 本脚本回答三个问题，决定各自能不能在服务端修：
 * A. 上游 glm 能否关掉/限制 thinking（`thinking.type=disabled` / `budget_tokens`）？
 * B. 上游 glm 的 max_tokens 是否精确？
 * C. Sider 端的请求体里有没有能表达长度上限的字段？
 */

import { loadBackendConfig } from '../src/config/backends.ts';

const { baseUrl, apiKey, model } = loadBackendConfig().deepseek;

interface Result {
  status: number;
  stopReason?: string;
  blocks: string;
  thinkingChars: number;
  textChars: number;
  outputTokens?: number;
  error?: string;
}

async function call(body: Record<string, unknown>): Promise<Result> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, ...body }),
  });

  const text = await response.text();
  if (!response.ok) {
    return { status: response.status, blocks: '', thinkingChars: 0, textChars: 0, error: text.slice(0, 200) };
  }

  const data = JSON.parse(text) as {
    stop_reason?: string;
    content?: Array<{ type: string; text?: string; thinking?: string }>;
    usage?: { output_tokens?: number };
  };
  const content = data.content ?? [];
  return {
    status: 200,
    stopReason: data.stop_reason,
    blocks: content.map((b) => b.type).join(','),
    thinkingChars: content.filter((b) => b.type === 'thinking')
      .reduce((n, b) => n + (b.thinking ?? '').length, 0),
    textChars: content.filter((b) => b.type === 'text')
      .reduce((n, b) => n + (b.text ?? '').length, 0),
    outputTokens: data.usage?.output_tokens,
  };
}

function show(label: string, r: Result): void {
  if (r.error) {
    console.log(`  ${label.padEnd(38)} HTTP ${r.status} -> ${r.error}`);
    return;
  }
  console.log(
    `  ${label.padEnd(38)} stop=${String(r.stopReason).padEnd(13)} ` +
      `out_tok=${String(r.outputTokens).padStart(4)}  blocks=[${r.blocks}]  ` +
      `thinking=${String(r.thinkingChars).padStart(4)}字 正文=${String(r.textChars).padStart(4)}字`,
  );
}

const ASK = [{ role: 'user', content: '用一句话说明什么是递归。' }];

console.log(`baseUrl=${baseUrl} model=${model}\n`);

console.log('=== A. 能不能关掉 thinking，把预算让给正文 ===');
show('基线（无 thinking 字段） max=100', await call({ max_tokens: 100, messages: ASK }));
show('thinking.type=disabled  max=100', await call({
  max_tokens: 100,
  thinking: { type: 'disabled' },
  messages: ASK,
}));
show('thinking budget_tokens=64 max=1000', await call({
  max_tokens: 1000,
  thinking: { type: 'enabled', budget_tokens: 64 },
  messages: ASK,
}));
// Z.AI 的 GLM 系列常用这个开关（OpenAI 兼容端的写法，试试 Anthropic 端认不认）
show('reasoning.enabled=false   max=100', await call({
  max_tokens: 100,
  reasoning: { enabled: false },
  messages: ASK,
}));
show('do_sample/thinking=false  max=100', await call({
  max_tokens: 100,
  thinking: false,
  messages: ASK,
}));

console.log('\n=== B. max_tokens 是否精确（观察 out_tok 与上限的关系）===');
for (const max of [16, 64, 256, 1024]) {
  show(`max_tokens=${max}`, await call({ max_tokens: max, messages: ASK }));
}

console.log('\n=== C. 大预算下正文能否正常产出 ===');
show('max_tokens=2000', await call({ max_tokens: 2000, messages: ASK }));
