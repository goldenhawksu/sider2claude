/**
 * 一次性侦察：能力学习在真实上游下的实际行为。
 *
 * 单元测试用 mock 验证了逻辑，但线上跑出来第二次请求仍带 thinking——
 * 说明真实链路里有单测没覆盖到的差异。本脚本绕开路由层，直接连续调用
 * adapter 两次，看学习到底有没有落上。
 */

import { AnthropicApiAdapter } from '../src/adapters/anthropic-adapter.ts';
import { loadBackendConfig } from '../src/config/backends.ts';
import type { AnthropicRequest } from '../src/types/anthropic.ts';

const config = loadBackendConfig();
const adapter = new AnthropicApiAdapter(config.deepseek);

// 拦截 fetch 只为观察发出去的请求体，不改变行为
const realFetch = globalThis.fetch;
let callIndex = 0;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const body = JSON.parse(init?.body as string) as Record<string, unknown>;
  callIndex += 1;
  console.log(
    `    → 上游调用 #${callIndex}: max_tokens=${body.max_tokens} ` +
      `thinking=${JSON.stringify(body.thinking)}`,
  );
  return realFetch(input, init);
}) as typeof fetch;

function ask(n: number): AnthropicRequest {
  return {
    model: 'claude-haiku-4.5',
    max_tokens: 64,
    messages: [{ role: 'user', content: `第 ${n} 次提问：什么是递归？` }],
  } as unknown as AnthropicRequest;
}

console.log(`上游 ${config.deepseek.baseUrl} 模型 ${config.deepseek.model}\n`);

for (let i = 1; i <= 3; i += 1) {
  console.log(`轮 ${i}:`);
  const before = callIndex;
  const response = await adapter.sendRequest(ask(i));
  const blocks = response.content.map((b) => b.type).join(',');
  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text: string }).text)
    .join('');
  console.log(
    `    ← 结果: 往返 ${callIndex - before} 次  stop=${response.stop_reason}  ` +
      `blocks=[${blocks}]  正文 ${text.length} 字`,
  );
  await new Promise((r) => setTimeout(r, 2000));
}

console.log('\n期望：轮 1 两次往返（撞上+重试），轮 2/3 各一次往返且带 thinking:disabled。');
