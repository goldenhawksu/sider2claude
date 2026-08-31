/**
 * 上游能力学习。
 *
 * 背景：`DEEPSEEK_BASE_URL` 可以指向任意 Anthropic 兼容端——今天是 Z.AI 的
 * `glm-5.3-flash`，明天可能换回 DeepSeek 官方的 `deepseek-v4-flash`。两家的行为
 * 并不一致（实测 GLM 完全忽略 `tool_choice`，而 CLAUDE.md 记录 DeepSeek 曾对
 * `{type:'tool'}` 直接 400），所以**不能把某一家的怪癖硬编码进主路径**。
 *
 * 本模块只学一件事：**这个上游会不会让 thinking 吃光小 `max_tokens` 预算**。
 *
 * 为什么这件事必须学而不能写死：它是 GLM 的实测缺陷（probe 见
 * deno/tools/probe-upstream-max-tokens.ts，max_tokens=256 时正文 0 字），
 * 但换个上游可能压根不存在。无条件注入 `thinking:{type:'disabled'}` 会
 * 白白关掉一个健康上游的推理能力；无条件不注入又会让 GLM 用户拿到空响应。
 * 判据来自响应本身，因此对两家都成立，也不需要用户配任何开关。
 */

import {
  noteThinkingAteBudget,
  noteThinkingDisabledRejected,
  resetUpstreamCapabilities,
  shouldDisableThinking,
  thinkingAteBudget,
} from '../src/utils/upstream-capabilities.ts';
import type { AnthropicResponse } from '../src/types/anthropic.ts';

function assertEquals<T>(actual: T, expected: T, what = '值') {
  if (actual !== expected) {
    throw new Error(`${what}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

/** 能力表是模块级全局状态，测试前后都要复位，避免顺序相关的偶发失败。 */
function capTest(name: string, fn: () => void) {
  Deno.test(name, () => {
    resetUpstreamCapabilities();
    try {
      fn();
    } finally {
      resetUpstreamCapabilities();
    }
  });
}

const KEY = 'https://api.z.ai/api/anthropic::glm-5.3-flash';
const OTHER = 'https://api.deepseek.com/anthropic::deepseek-v4-flash';

function response(
  stopReason: AnthropicResponse['stop_reason'],
  blocks: Array<{ type: string; text?: string; thinking?: string }>,
): AnthropicResponse {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    content: blocks as AnthropicResponse['content'],
    model: 'claude-haiku-4.5',
    stop_reason: stopReason,
    usage: { input_tokens: 10, output_tokens: 64 },
  };
}

// ── 判据 ────────────────────────────────────────────────────────────────────

capTest('判据：stop_reason=max_tokens + 只有 thinking + 正文为空 => 命中', () => {
  const hit = thinkingAteBudget(response('max_tokens', [{ type: 'thinking', thinking: '想了很多' }]));
  assertEquals(hit, true, '这正是 probe 实测到的形态');
});

capTest('判据：有正文就不算命中（哪怕同时有 thinking、哪怕撞了 max_tokens）', () => {
  const hit = thinkingAteBudget(
    response('max_tokens', [
      { type: 'thinking', thinking: '想了想' },
      { type: 'text', text: '递归是……' },
    ]),
  );
  assertEquals(hit, false, '有正文说明预算够用，截断是正常的 max_tokens 行为');
});

capTest('判据：正常结束不算命中', () => {
  assertEquals(
    thinkingAteBudget(response('end_turn', [{ type: 'thinking', thinking: 'x' }])),
    false,
    'end_turn 不是这个缺陷',
  );
});

capTest('判据：没有 thinking 块时不算命中（那是普通的输出截断）', () => {
  assertEquals(
    thinkingAteBudget(response('max_tokens', [{ type: 'text', text: '半句话' }])),
    false,
    '纯文本被 max_tokens 截断是规范行为，不该归到这个缺陷',
  );
});

capTest('判据：只有空 text 块也算命中（上游可能给个空壳）', () => {
  assertEquals(
    thinkingAteBudget(
      response('max_tokens', [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: '' }]),
    ),
    true,
    '正文为空即命中',
  );
});

// ── 学习与应用 ──────────────────────────────────────────────────────────────

capTest('学习前：不注入 disabled，尊重上游默认推理行为', () => {
  assertEquals(shouldDisableThinking(KEY, 64), false, '没有证据就不该动上游的推理');
  assertEquals(shouldDisableThinking(KEY, 100000), false, '大预算同样不动');
});

capTest('学习后：同等或更小的预算主动注入 disabled', () => {
  noteThinkingAteBudget(KEY, 256);

  assertEquals(shouldDisableThinking(KEY, 256), true, '同等预算');
  assertEquals(shouldDisableThinking(KEY, 64), true, '更小的预算更该注入');
});

capTest('学习后：阈值由实测失败点推出，不写死某个魔数', () => {
  // 观察到 256 失败 -> 512（2 倍安全余量）以内都注入；再大就交给上游自己判断。
  // 若 2 倍仍失败，下一次观察会把失败点抬高，阈值自然收敛。
  noteThinkingAteBudget(KEY, 256);

  assertEquals(shouldDisableThinking(KEY, 512), true, '2 倍余量内');
  assertEquals(shouldDisableThinking(KEY, 513), false, '超出余量交给上游');
});

capTest('学习后：失败点抬高时阈值随之扩大', () => {
  noteThinkingAteBudget(KEY, 256);
  assertEquals(shouldDisableThinking(KEY, 900), false, '扩大前');

  noteThinkingAteBudget(KEY, 800);
  assertEquals(shouldDisableThinking(KEY, 900), true, '扩大后');
});

capTest('学习后：失败点变小不会缩小已知范围（只增不减，避免抖动）', () => {
  noteThinkingAteBudget(KEY, 800);
  noteThinkingAteBudget(KEY, 64);

  assertEquals(shouldDisableThinking(KEY, 900), true, '仍按更大的失败点算');
});

capTest('能力按上游隔离：一个上游的缺陷不影响另一个', () => {
  noteThinkingAteBudget(KEY, 256);

  assertEquals(shouldDisableThinking(KEY, 64), true, 'GLM 已学到');
  assertEquals(
    shouldDisableThinking(OTHER, 64),
    false,
    '换成 DeepSeek 就该重新观察——两家行为并不一致',
  );
});

// ── 上游拒绝 disabled 时的降级 ──────────────────────────────────────────────

capTest('上游拒绝 disabled 后不再尝试，避免每次请求都白撞一次 400', () => {
  noteThinkingAteBudget(KEY, 256);
  assertEquals(shouldDisableThinking(KEY, 64), true, '拒绝前');

  noteThinkingDisabledRejected(KEY);
  assertEquals(
    shouldDisableThinking(KEY, 64),
    false,
    '上游不认这个参数就只能作罢——继续发只会把每个小预算请求都变成 400',
  );
});

capTest('上游拒绝 disabled 是终态，后续再观察到缺陷也不重试', () => {
  noteThinkingDisabledRejected(KEY);
  noteThinkingAteBudget(KEY, 256);

  assertEquals(shouldDisableThinking(KEY, 64), false, '已知不支持就别再试');
});
