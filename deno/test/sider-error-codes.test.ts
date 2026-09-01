/**
 * Sider 上游错误码 -> 本服务错误语义的确定性测试。
 *
 * 两件事在这里锁定：
 *
 * 1. **1135 的恢复时长必须从上游消息里解析出来。** 上游明说了 "Please try again
 *    after 117 minutes"，硬编码冷却会在两个方向同时错——说 1 分钟时白闲置一小时
 *    额度，说 272 分钟时每分钟去撞一次墙。实测跨度 1 / 117 / 261 / 272 分钟。
 *
 * 2. **603 不是上游故障。** 它是调用方的输入过长，报 502 会让客户端以为是服务端
 *    抖动而去重试，而重试同一个超长载荷必然再失败。
 */

import { parseSiderRetryAfterMs, siderUpstreamError } from '../src/utils/sse-line-reader.ts';
import { resolveSiderCooldownMs } from '../src/utils/sider-availability.ts';

function assertEquals<T>(actual: T, expected: T, what = '值') {
  if (actual !== expected) {
    throw new Error(`${what}：期望 ${String(expected)}，实际 ${String(actual)}`);
  }
}

Deno.test('错误码：解析上游 1135 消息里的恢复时长', () => {
  // 实测原文（四个不同时长都出现过）。
  const real =
    "You've reached the current usage limit. This limit ensures fair use for all users. " +
    'Please try again after 117 minutes.';
  assertEquals(parseSiderRetryAfterMs(real), 117 * 60_000, '117 分钟');

  assertEquals(parseSiderRetryAfterMs('try again after 1 minutes'), 60_000, '1 分钟');
  assertEquals(parseSiderRetryAfterMs('try again after 272 minutes'), 272 * 60_000, '272 分钟');
  assertEquals(parseSiderRetryAfterMs('please try again after 2 hours'), 2 * 3_600_000, '小时');
  assertEquals(parseSiderRetryAfterMs('after 45 seconds'), 45_000, '秒');
});

Deno.test('错误码：解析不出时返回 undefined，让调用方回退到自己的默认值', () => {
  // 上游随时可能改文案。解析失效时整套熔断要退回原来的行为，而不是失去冷却。
  assertEquals(parseSiderRetryAfterMs('usage limit reached'), undefined, '没有时长');
  assertEquals(parseSiderRetryAfterMs('try again after soon'), undefined, '不是数字');
  assertEquals(parseSiderRetryAfterMs('try again after 0 minutes'), undefined, '零时长');
  assertEquals(parseSiderRetryAfterMs(''), undefined, '空消息');
});

Deno.test('错误码：1135 带出解析后的 retryAfterMs，其余码不带', () => {
  const quota = siderUpstreamError(1135, 'limit reached. Please try again after 3 minutes.');
  assertEquals(quota.statusCode, 429, '1135 状态码');
  assertEquals(quota.retryAfterMs, 3 * 60_000, '1135 恢复时长');
  assertEquals(quota.upstreamMessage.startsWith('limit reached'), true, '保留上游原文');

  // 别的码消息里即便碰巧出现 "after N minutes" 也不该被当成额度恢复时长。
  const other = siderUpstreamError(707, 'model unavailable, retry after 5 minutes');
  assertEquals(other.retryAfterMs, undefined, '非 1135 不解析时长');
});

Deno.test('错误码：603 是调用方输入过长，映射成 413 而非 502', () => {
  const oversize = siderUpstreamError(603, 'Too many words in the query');
  assertEquals(oversize.statusCode, 413, '603 状态码');

  // 其余业务码仍按上游故障处理。
  assertEquals(siderUpstreamError(707, 'unavailable').statusCode, 502, '707 状态码');
  assertEquals(siderUpstreamError(1101, 'active request').statusCode, 502, '1101 状态码');
});

Deno.test('保守冷却：上游给了时长就按它，没给才用固定两档', () => {
  // 硬编码「opus 就是一小时」在上游说 1 分钟时会白白闲置 59 分钟的可用额度。
  assertEquals(resolveSiderCooldownMs('claude-opus-4.8', 60_000), 60_000, 'opus 按上游时长');
  assertEquals(resolveSiderCooldownMs('claude-sonnet-5', 117 * 60_000), 117 * 60_000, '非 opus');

  // clamp：实测上游说过 272 分钟，夹到 2 小时后交给到期后的重试去摸恢复点。
  assertEquals(resolveSiderCooldownMs('claude-sonnet-5', 272 * 60_000), 2 * 60 * 60_000, '上界');
  assertEquals(resolveSiderCooldownMs('claude-sonnet-5', 1_000), 30_000, '下界');

  // 解析不出时回退到实测经验值，行为与改动前一致。
  assertEquals(resolveSiderCooldownMs('claude-opus-4.8'), 60 * 60_000, 'opus 默认');
  assertEquals(resolveSiderCooldownMs('claude-sonnet-5'), 60_000, '非 opus 默认');
});
