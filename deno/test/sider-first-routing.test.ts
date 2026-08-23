/**
 * 第 1 期路由策略的确定性测试。
 *
 * 背景（都来自对 Sider 的实测，不是推测）：
 * - Sider 是包年订阅（边际成本 0），DeepSeek 按量付费，因此能用 Sider 的就不该给 DeepSeek；
 * - 但 Sider 有两道硬约束：单请求约 32K 字符通过 / 44K 被 `code 603` 硬拒；
 *   以及**按模型分开**的用量额度，超出返回 `code 1135`；
 * - opus 档单窗口只有 2~3 次且 200 秒不恢复；sonnet 档约 6 次/分钟、约 1 分钟回血。
 *
 * 本文件锁定三件事：长文本判据不再误伤续轮、超限请求不投 Sider、熔断按模型隔离。
 */

import { RouterEngine } from '../src/routing/router-engine.ts';
import type { BackendConfig } from '../src/config/backends.ts';
import type { AnthropicRequest } from '../src/types/anthropic.ts';
import {
  recordSiderQuotaExhausted,
  resetSiderAvailability,
  siderCooldownMsFor,
} from '../src/utils/sider-availability.ts';

function assertEquals<T>(actual: T, expected: T, what = '值') {
  if (actual !== expected) {
    throw new Error(`${what}：期望 ${String(expected)}，实际 ${String(actual)}`);
  }
}

function config(): BackendConfig {
  return {
    sider: { enabled: true, apiUrl: 'https://sider.ai/api/chat/v1/completions', authToken: 't' },
    deepseek: {
      enabled: true,
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/anthropic',
      apiKey: 'k',
      model: 'deepseek-v4-flash',
    },
    routing: {
      defaultBackend: 'sider',
      autoFallback: true,
      preferSiderForSimpleChat: true,
      debugMode: false,
    },
  } as unknown as BackendConfig;
}

function req(overrides: Partial<AnthropicRequest> = {}): AnthropicRequest {
  return {
    model: 'claude-sonnet-5',
    max_tokens: 8192,
    messages: [{ role: 'user', content: '你好' }],
    ...overrides,
  } as AnthropicRequest;
}

/** 一段真实编码对话：历史里必然出现"写/脚本/文档/README"这类词。 */
const CODING_HISTORY: AnthropicRequest['messages'] = [
  { role: 'user', content: '帮我写一个整理日志的脚本' },
  { role: 'assistant', content: '好的，我生成一个脚本并把说明写进 README 文档。' },
  { role: 'user', content: '再把大纲整理成报告' },
  { role: 'assistant', content: '已完成，输出了提纲和文章草稿。' },
];

/**
 * 长文本判据曾经扫描整段对话，导致「对话越长越必然误判」：最后一轮只说
 * 「请继续」也会被判成长文生成而路由去 DeepSeek。判据改为只看当前轮意图。
 */
Deno.test('路由：历史里有长文触发词，但本轮只是续轮 -> 走 Sider', () => {
  resetSiderAvailability();
  const engine = new RouterEngine(config());

  for (const text of ['请继续', '好的', '嗯']) {
    const decision = engine.decide(
      req({ messages: [...CODING_HISTORY, { role: 'user', content: text }] }),
    );
    assertEquals(decision.backend, 'sider', `「${text}」的后端`);
    assertEquals(decision.ruleId, 'rule_5_simple_chat_prefer_sider', `「${text}」的规则`);
  }
});

Deno.test('路由：本轮真的要长文生成时仍走 DeepSeek（修复不得误伤）', () => {
  resetSiderAvailability();
  const engine = new RouterEngine(config());

  const decision = engine.decide(
    req({ messages: [{ role: 'user', content: '帮我做一个关于季度业绩的 PPT 演示文稿' }] }),
  );
  assertEquals(decision.backend, 'deepseek', '后端');
  assertEquals(decision.ruleId, 'rule_5_long_form_generation', '规则');
});

Deno.test('路由：tool_result 内容不算用户意图，不触发长文判据', () => {
  resetSiderAvailability();
  const engine = new RouterEngine(config());

  // 上一轮 Read 出来的 README 全文，不代表用户这一轮要写 README
  const decision = engine.decide(req({
    messages: [
      { role: 'user', content: '看看这个文件' },
      { role: 'assistant', content: '好' },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'x',
            content: '请撰写一份完整的项目报告文档，生成大纲和文章草稿。',
          },
          { type: 'text', text: '嗯' },
        ],
      } as unknown as AnthropicRequest['messages'][number],
    ],
  }));
  assertEquals(decision.backend, 'sider', '后端');
});

/**
 * 尺寸门：实测 32,000 字符通过、44,000 字符被 `code 603` 硬拒。
 * 超限请求投给 Sider 必然失败，白费一个往返，不如一开始就别选它。
 */
Deno.test('路由：超过 Sider 体量上限的请求不投 Sider', () => {
  resetSiderAvailability();
  const engine = new RouterEngine(config());

  const small = engine.decide(req({ messages: [{ role: 'user', content: '你好' }] }));
  assertEquals(small.backend, 'sider', '小请求');

  const big = engine.decide(req({ messages: [{ role: 'user', content: 'x'.repeat(40_000) }] }));
  assertEquals(big.backend, 'deepseek', '超限请求');
  assertEquals(big.ruleId, 'rule_5_simple_chat_deepseek', '超限请求的规则');
});

/**
 * 熔断必须按模型隔离：实测同一时刻 sonnet-5 可用而 opus-4.8 已耗尽，
 * 一刀切会把还有额度的模型一起误伤。
 */
Deno.test('路由：某模型配额耗尽后熔断，不影响其他模型', () => {
  resetSiderAvailability();
  const engine = new RouterEngine(config());

  const before = engine.decide(req({ model: 'claude-opus-4.6' }));
  assertEquals(before.backend, 'sider', '熔断前');

  recordSiderQuotaExhausted('claude-opus-4.6');

  const after = engine.decide(req({ model: 'claude-opus-4.6' }));
  assertEquals(after.backend, 'deepseek', '熔断后改投 DeepSeek');

  const other = engine.decide(req({ model: 'claude-sonnet-5' }));
  assertEquals(other.backend, 'sider', '同一时刻其他模型不受影响');
});

/**
 * 冷却时长分两档，依据是实测的额度窗口：
 * opus 档等 200 秒仍未恢复（小时/天级），其余约 1 分钟回血。
 */
Deno.test('熔断：opus 档冷却 1 小时，其余按上游提示 1 分钟', () => {
  assertEquals(siderCooldownMsFor('claude-opus-5'), 60 * 60_000, 'opus-5');
  assertEquals(siderCooldownMsFor('claude-opus-4.6'), 60 * 60_000, 'opus-4.6');
  assertEquals(siderCooldownMsFor('claude-opus-4.8-think'), 60 * 60_000, 'opus-4.8-think');
  assertEquals(siderCooldownMsFor('claude-sonnet-5'), 60_000, 'sonnet-5');
  assertEquals(siderCooldownMsFor('claude-haiku-4.5'), 60_000, 'haiku-4.5');
});

Deno.test('熔断：冷却到期后自动恢复', () => {
  resetSiderAvailability();
  const engine = new RouterEngine(config());

  const realNow = Date.now;
  const base = realNow();
  try {
    recordSiderQuotaExhausted('claude-sonnet-5', base);

    Date.now = () => base + 30_000; // 冷却窗口内
    assertEquals(engine.decide(req()).backend, 'deepseek', '30 秒后仍熔断');

    Date.now = () => base + 61_000; // 冷却已过
    assertEquals(engine.decide(req()).backend, 'sider', '61 秒后恢复');
  } finally {
    Date.now = realNow;
  }
});

/**
 * 熔断只影响"要不要主动选 Sider"。带 Claude Code 工具的请求本来就该走
 * DeepSeek，熔断与否都不该改变这一点。
 */
Deno.test('熔断：不改变工具请求的既有路由', () => {
  resetSiderAvailability();
  const engine = new RouterEngine(config());
  const toolReq = req({
    tools: [{
      name: 'Bash',
      description: 'run',
      input_schema: { type: 'object', properties: {} },
    }] as unknown as AnthropicRequest['tools'],
  });

  assertEquals(engine.decide(toolReq).ruleId, 'rule_2_claude_tools', '熔断前');
  recordSiderQuotaExhausted('claude-sonnet-5');
  assertEquals(engine.decide(toolReq).ruleId, 'rule_2_claude_tools', '熔断后不变');
});

/**
 * 熔断状态是模块级全局。触发过 1135 的测试若不复位，会顺着文件执行顺序
 * 泄漏给后续测试——今天不炸只是因为它恰好排在后面。这条守着复位入口存在。
 */
Deno.test('熔断：复位入口可用，避免测试间状态泄漏', () => {
  recordSiderQuotaExhausted('claude-sonnet-5');
  const engine = new RouterEngine(config());
  assertEquals(engine.decide(req()).backend, 'deepseek', '复位前');

  resetSiderAvailability();
  assertEquals(engine.decide(req()).backend, 'sider', '复位后');
});
