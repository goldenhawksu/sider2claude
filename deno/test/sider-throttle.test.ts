/**
 * Sider 自适应限流器的确定性测试。
 *
 * 背景：保守策略下「一次 1135 就锁死该模型一小时」是全有全无的——冷却期内额度
 * 在持续回血却一个请求都不发。目标既然是用足包年额度，就必须持续试探。本模块
 * 用 AIMD（加性增、乘性减）替代固定冷却，本文件锁定它的收敛行为。
 *
 * 所有 API 都接受 `now` 参数，因此这里全用假时间戳推进，不用 `setTimeout`——
 * 固定等待会随机器负载浮动，让门禁偶发变红，而会偶发红的门禁等于没有门禁。
 */

import {
  canUseSider,
  consumeSiderSlot,
  getSiderThrottleSnapshot,
  recordSiderConcurrencyLimit,
  recordSiderOversize,
  recordSiderQuotaExhausted,
  recordSiderRejection,
  recordSiderSuccess,
  resetSiderThrottle,
} from '../src/utils/sider-throttle.ts';

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

/** 限流器是模块级全局状态，测试前后都要复位，避免顺序相关的偶发失败。 */
function throttleTest(name: string, fn: () => void) {
  Deno.test(name, () => {
    resetSiderThrottle();
    try {
      fn();
    } finally {
      resetSiderThrottle();
    }
  });
}

const T0 = 1_700_000_000_000;
const MODEL = 'claude-sonnet-5';

throttleTest('限流器：初始满桶，扣完令牌后拒绝，时间推进后回血', () => {
  // 初始速率 12/分，桶容量等于速率
  for (let i = 0; i < 12; i += 1) {
    assertEquals(canUseSider(MODEL, 100, T0).ok, true, `第 ${i + 1} 次判定`);
    consumeSiderSlot(MODEL, T0);
  }

  assertEquals(canUseSider(MODEL, 100, T0).ok, false, '扣完后的判定');

  // 12/分 = 每 5 秒回 1 个令牌
  assertEquals(canUseSider(MODEL, 100, T0 + 5_000).ok, true, '5 秒后的判定');
});

throttleTest('限流器：检查不消耗令牌，只有 consume 才扣', () => {
  for (let i = 0; i < 50; i += 1) {
    assertEquals(canUseSider(MODEL, 100, T0).ok, true, `第 ${i + 1} 次只读判定`);
  }

  // 路由引擎在规则匹配开头就要判定，但那一刻还不知道最终会不会真投 Sider。
  // 若检查即扣费，每个走 DeepSeek 的工具请求都会白扣一次 Sider 额度。
  const snapshot = getSiderThrottleSnapshot(T0);
  assertEquals(snapshot[0]?.ratePerMin, 12, '只读判定后的速率');
});

throttleTest('限流器：1135 乘性降速并清空令牌', () => {
  recordSiderQuotaExhausted(MODEL, T0);

  // 12 * 0.6 = 7.2
  assertEquals(getSiderThrottleSnapshot(T0)[0]?.ratePerMin, 7.2, '降速后速率');
  assertEquals(canUseSider(MODEL, 100, T0).ok, false, '清空令牌后立刻判定');

  recordSiderQuotaExhausted(MODEL, T0 + 1_000);
  // 7.2 * 0.6 = 4.32 -> 快照保留一位小数
  assertEquals(getSiderThrottleSnapshot(T0)[0]?.ratePerMin, 4.3, '二次降速后速率');
});

throttleTest('限流器：连续成功才升速，零星成功不升', () => {
  for (let i = 0; i < 7; i += 1) {
    recordSiderSuccess(MODEL, 100, T0);
  }
  assertEquals(getSiderThrottleSnapshot(T0)[0]?.ratePerMin, 12, '7 次成功后速率不变');

  recordSiderSuccess(MODEL, 100, T0);
  // 12 * 1.2 = 14.4
  assertEquals(getSiderThrottleSnapshot(T0)[0]?.ratePerMin, 14.4, '第 8 次成功后升速');
});

throttleTest('限流器：603 把体量上限降到失败载荷以下', () => {
  assertEquals(canUseSider(MODEL, 39_000, T0).ok, true, '初始上限内的载荷');

  recordSiderOversize(MODEL, 44_000, T0);

  // 44000 * 0.85 = 37400
  assertEquals(getSiderThrottleSnapshot(T0)[0]?.maxChars, 37_400, '降级后的上限');
  assertEquals(canUseSider(MODEL, 39_000, T0).ok, false, '超过新上限的载荷');
  assertEquals(canUseSider(MODEL, 30_000, T0).ok, true, '新上限内的载荷');
});

throttleTest('限流器：只有贴近上限的成功才上探体量', () => {
  // 远小于上限的成功不构成"上限估低了"的证据
  recordSiderSuccess(MODEL, 1_000, T0);
  assertEquals(getSiderThrottleSnapshot(T0)[0]?.maxChars, 40_000, '小载荷成功后的上限');

  // 40000 * 0.9 = 36000，贴近上限
  recordSiderSuccess(MODEL, 37_000, T0);
  // 40000 * 1.1 = 44000
  assertEquals(getSiderThrottleSnapshot(T0)[0]?.maxChars, 44_000, '大载荷成功后的上限');
});

throttleTest('限流器：连续 3 次 1135 才熔断，到期 half-open 只放一个探测', () => {
  recordSiderQuotaExhausted(MODEL, T0);
  recordSiderQuotaExhausted(MODEL, T0);
  assertEquals(getSiderThrottleSnapshot(T0)[0]?.cooldownMs, 0, '2 次 1135 后不该熔断');

  recordSiderQuotaExhausted(MODEL, T0);
  assertEquals(getSiderThrottleSnapshot(T0)[0]?.cooldownMs, 30_000, '3 次 1135 后的冷却');

  assertEquals(canUseSider(MODEL, 100, T0 + 10_000).ok, false, '冷却期内判定');

  // 到期 = half-open，放行一个探测去碰一下
  const probeTime = T0 + 31_000;
  assertEquals(canUseSider(MODEL, 100, probeTime).ok, true, '冷却到期后的探测放行');
  consumeSiderSlot(MODEL, probeTime);
  assertEquals(canUseSider(MODEL, 100, probeTime).ok, false, '探测在途时不再放行第二个');
});

throttleTest('限流器：探测成功即解除熔断并重置退避', () => {
  for (let i = 0; i < 3; i += 1) recordSiderQuotaExhausted(MODEL, T0);

  const probeTime = T0 + 31_000;
  consumeSiderSlot(MODEL, probeTime);
  recordSiderSuccess(MODEL, 100, probeTime);

  assertEquals(getSiderThrottleSnapshot(probeTime)[0]?.cooldownMs, 0, '探测成功后的冷却');
  assertEquals(canUseSider(MODEL, 100, probeTime).ok, true, '探测成功后的判定');

  // 退避已重置：下一轮熔断重新从 30s 起步，而不是接着翻倍
  for (let i = 0; i < 3; i += 1) recordSiderQuotaExhausted(MODEL, probeTime);
  assertEquals(getSiderThrottleSnapshot(probeTime)[0]?.cooldownMs, 30_000, '重置后的再次冷却');
});

throttleTest('限流器：探测失败则退避翻倍', () => {
  for (let i = 0; i < 3; i += 1) recordSiderQuotaExhausted(MODEL, T0);

  const probeTime = T0 + 31_000;
  consumeSiderSlot(MODEL, probeTime);
  recordSiderQuotaExhausted(MODEL, probeTime);

  assertEquals(getSiderThrottleSnapshot(probeTime)[0]?.cooldownMs, 60_000, '一次探测失败后的冷却');

  const probe2 = probeTime + 61_000;
  consumeSiderSlot(MODEL, probe2);
  recordSiderQuotaExhausted(MODEL, probe2);
  assertEquals(getSiderThrottleSnapshot(probe2)[0]?.cooldownMs, 120_000, '二次探测失败后的冷却');
});

throttleTest('限流器：退避封顶按档位区分，opus 到 1 小时、其余到 5 分钟', () => {
  const opus = 'claude-opus-4.8';

  for (let i = 0; i < 3; i += 1) recordSiderQuotaExhausted(opus, T0);
  let now = T0;
  // 反复探测失败，退避一路翻倍到封顶
  for (let i = 0; i < 12; i += 1) {
    now += getSiderThrottleSnapshot(now)[0]!.cooldownMs + 1_000;
    consumeSiderSlot(opus, now);
    recordSiderQuotaExhausted(opus, now);
  }
  assertEquals(getSiderThrottleSnapshot(now)[0]?.cooldownMs, 60 * 60_000, 'opus 档退避封顶');

  resetSiderThrottle();

  for (let i = 0; i < 3; i += 1) recordSiderQuotaExhausted(MODEL, T0);
  now = T0;
  for (let i = 0; i < 12; i += 1) {
    now += getSiderThrottleSnapshot(now)[0]!.cooldownMs + 1_000;
    consumeSiderSlot(MODEL, now);
    recordSiderQuotaExhausted(MODEL, now);
  }
  assertEquals(getSiderThrottleSnapshot(now)[0]?.cooldownMs, 5 * 60_000, 'sonnet 档退避封顶');
});

throttleTest('限流器：状态按模型隔离，一个熔断不影响另一个', () => {
  const opus = 'claude-opus-4.8';

  for (let i = 0; i < 3; i += 1) recordSiderQuotaExhausted(opus, T0);
  recordSiderOversize(opus, 20_000, T0);

  assertEquals(canUseSider(opus, 100, T0).ok, false, 'opus 熔断中');
  assertEquals(canUseSider(MODEL, 100, T0).ok, true, 'sonnet 不受影响');
  assertEquals(canUseSider(MODEL, 39_000, T0).ok, true, 'sonnet 体量上限不受影响');
});

throttleTest('限流器：快照把需要关注的排在前面（先熔断、再低速）', () => {
  recordSiderSuccess('healthy', 100, T0);
  recordSiderQuotaExhausted('slow', T0);
  for (let i = 0; i < 3; i += 1) recordSiderQuotaExhausted('blocked', T0);

  const snapshot = getSiderThrottleSnapshot(T0);
  assertEquals(snapshot[0]?.model, 'blocked', '第一行');
  assertEquals(snapshot[1]?.model, 'slow', '第二行');
  assertEquals(snapshot[2]?.model, 'healthy', '第三行');
  assert(snapshot[0]!.lastQuotaAt === T0, '熔断行应记录最近一次 1135 时刻');
});

// ── 持久性拒绝（非 1135/603 的业务错误码，如 707「该模型不可用」）────────────
//
// 线上实测的缺口：`claude-fable-5` 恒返回 707，三次复现无一成功。频次与体量两个
// 维度都假设「换个时机或换个载荷就能成功」，对这类失败学不到任何东西，于是每个
// 请求都要白撞一次 Sider 再 fallback。下面这组用例锁定新通道的收敛与恢复行为。

throttleTest('限流器：连续 3 次持久性拒绝才停投，不足则继续投递', () => {
  recordSiderRejection(MODEL, 707, T0);
  recordSiderRejection(MODEL, 707, T0);
  assertEquals(getSiderThrottleSnapshot(T0)[0]?.cooldownMs, 0, '2 次拒绝后不该停投');
  assertEquals(canUseSider(MODEL, 100, T0).ok, true, '2 次拒绝后仍可投递');

  recordSiderRejection(MODEL, 707, T0);
  assertEquals(getSiderThrottleSnapshot(T0)[0]?.cooldownMs, 5 * 60_000, '3 次拒绝后的停投时长');
  assertEquals(canUseSider(MODEL, 100, T0).ok, false, '3 次拒绝后停投');
});

throttleTest('限流器：持久性拒绝不动速率与体量上限', () => {
  // 这类失败与时机、载荷都无关，调那两个参数没有意义——调了反而会在模型恢复后
  // 留下一个凭空变慢的限流器。
  for (let i = 0; i < 3; i += 1) recordSiderRejection(MODEL, 707, T0);

  const snapshot = getSiderThrottleSnapshot(T0)[0]!;
  assertEquals(snapshot.ratePerMin, 12, '拒绝后的速率');
  assertEquals(snapshot.maxChars, 40_000, '拒绝后的体量上限');
});

throttleTest('限流器：一次成功即清零拒绝计数，不累积到停投', () => {
  recordSiderRejection(MODEL, 707, T0);
  recordSiderRejection(MODEL, 707, T0);
  recordSiderSuccess(MODEL, 100, T0);
  recordSiderRejection(MODEL, 707, T0);
  recordSiderRejection(MODEL, 707, T0);

  // 中间那次成功把计数清零了，此刻只累积了 2 次，不该停投。
  // 没有这条，偶发抖动会跨很长时间攒够 3 次，把一次次孤立故障放大成停投。
  assertEquals(getSiderThrottleSnapshot(T0)[0]?.cooldownMs, 0, '成功打断后的停投状态');
});

throttleTest('限流器：拒绝停投到期后 half-open 探测，成功即恢复', () => {
  for (let i = 0; i < 3; i += 1) recordSiderRejection(MODEL, 707, T0);

  const probeTime = T0 + 5 * 60_000 + 1_000;
  assertEquals(canUseSider(MODEL, 100, probeTime).ok, true, '停投到期后放行探测');
  consumeSiderSlot(MODEL, probeTime);
  assertEquals(canUseSider(MODEL, 100, probeTime).ok, false, '探测在途时不再放行第二个');

  recordSiderSuccess(MODEL, 100, probeTime);
  assertEquals(getSiderThrottleSnapshot(probeTime)[0]?.cooldownMs, 0, '探测成功后的停投状态');
  assertEquals(canUseSider(MODEL, 100, probeTime).ok, true, '探测成功后恢复投递');
});

throttleTest('限流器：拒绝探测再失败则退避翻倍并按档位封顶', () => {
  for (let i = 0; i < 3; i += 1) recordSiderRejection(MODEL, 707, T0);

  const probeTime = T0 + 5 * 60_000 + 1_000;
  consumeSiderSlot(MODEL, probeTime);
  recordSiderRejection(MODEL, 707, probeTime);
  // 5 分钟已是非 opus 档的封顶值，翻倍后仍被夹回 5 分钟
  assertEquals(getSiderThrottleSnapshot(probeTime)[0]?.cooldownMs, 5 * 60_000, '非 opus 档封顶');

  resetSiderThrottle();

  const opus = 'claude-opus-4.8';
  for (let i = 0; i < 3; i += 1) recordSiderRejection(opus, 707, T0);
  const opusProbe = T0 + 5 * 60_000 + 1_000;
  consumeSiderSlot(opus, opusProbe);
  recordSiderRejection(opus, 707, opusProbe);
  assertEquals(
    getSiderThrottleSnapshot(opusProbe)[0]?.cooldownMs,
    10 * 60_000,
    'opus 档可继续翻倍',
  );
});

throttleTest('限流器：拒绝状态按模型隔离', () => {
  const other = 'claude-sonnet-4.6';
  for (let i = 0; i < 3; i += 1) recordSiderRejection('claude-fable-5', 707, T0);

  assertEquals(canUseSider('claude-fable-5', 100, T0).ok, false, 'fable 已停投');
  assertEquals(canUseSider(other, 100, T0).ok, true, '其余模型不受影响');
});

throttleTest('限流器：快照带出最近一次拒绝的时刻与错误码', () => {
  recordSiderRejection(MODEL, 707, T0);
  const snapshot = getSiderThrottleSnapshot(T0)[0]!;
  assertEquals(snapshot.lastRejectAt, T0, '最近拒绝时刻');
  assertEquals(snapshot.lastRejectCode, 707, '最近拒绝错误码');
});

throttleTest('限流器：1135 与持久性拒绝各自独立计数，不互相污染', () => {
  // 混着来：2 次 1135 + 2 次 707，两边都没到 3，不该停投。
  // 若共用一个计数器，这里会误判成"连续 4 次失败"。
  recordSiderQuotaExhausted(MODEL, T0);
  recordSiderRejection(MODEL, 707, T0);
  recordSiderQuotaExhausted(MODEL, T0);
  recordSiderRejection(MODEL, 707, T0);

  assertEquals(getSiderThrottleSnapshot(T0)[0]?.cooldownMs, 0, '两类失败混合后的停投状态');
});

// ── 并发限流（1101）─────────────────────────────────────────────────────────
//
// 线上遥测实测：13 次 1101 全部落在两簇里，中位相邻间隔 6 毫秒，92% 的间隔小于
// 2 秒，每簇恰好只有一个请求成功——这是「Sider 同一时刻只接一个 active request」，
// 不是模型坏了。下面第一条是**关键回归**：并发簇绝不能触发停投。

throttleTest('限流器：并发簇（1101）只降速，绝不触发停投（关键回归）', () => {
  // 模拟一次 10 并发：9 个几乎同时失败，中间没有成功穿插。
  // 若走持久性拒绝通道，第 3 次就会把一个完全健康的模型停投 5 分钟。
  for (let i = 0; i < 9; i += 1) {
    recordSiderConcurrencyLimit(MODEL, T0 + i * 2);
  }

  const snapshot = getSiderThrottleSnapshot(T0 + 20)[0]!;
  assertEquals(snapshot.cooldownMs, 0, '并发簇后的停投状态');
  assertEquals(canUseSider(MODEL, 100, T0 + 60_000).ok, true, '令牌回血后仍可投递');
});

throttleTest('限流器：一簇并发只降一次速，不把速率打到底', () => {
  // 实测簇内跨度 267 毫秒、中位间隔 6 毫秒。若逐个降速，9 次会把 12/min 打到
  // 下限 1（12 × 0.6^9），之后要上百次连续成功才爬得回来——一次并发就长时间
  // 压制了零边际成本的首选后端。
  for (let i = 0; i < 9; i += 1) {
    recordSiderConcurrencyLimit(MODEL, T0 + i * 2);
  }

  // 只降一次：12 * 0.6 = 7.2
  assertEquals(getSiderThrottleSnapshot(T0 + 20)[0]?.ratePerMin, 7.2, '一簇并发后的速率');
});

throttleTest('限流器：超过合并窗口的并发事件会再次降速', () => {
  recordSiderConcurrencyLimit(MODEL, T0);
  assertEquals(getSiderThrottleSnapshot(T0)[0]?.ratePerMin, 7.2, '首次降速');

  // 1 秒外是另一次独立的并发事件，应当再降一次：7.2 * 0.6 = 4.32
  recordSiderConcurrencyLimit(MODEL, T0 + 1_500);
  assertEquals(getSiderThrottleSnapshot(T0 + 1_500)[0]?.ratePerMin, 4.3, '二次降速');
});

throttleTest('限流器：1101 乘性降速并清空令牌', () => {
  recordSiderConcurrencyLimit(MODEL, T0);

  // 12 * 0.6 = 7.2，与 1135 同样的降速动作
  assertEquals(getSiderThrottleSnapshot(T0)[0]?.ratePerMin, 7.2, '降速后速率');
  assertEquals(canUseSider(MODEL, 100, T0).ok, false, '清空令牌后立刻判定');
});

throttleTest('限流器：1101 不动体量上限', () => {
  // 并发与载荷大小无关，调体量上限只会在并发结束后留下一个凭空变小的限制
  recordSiderConcurrencyLimit(MODEL, T0);
  assertEquals(getSiderThrottleSnapshot(T0)[0]?.maxChars, 40_000, '并发限流后的体量上限');
});

throttleTest('限流器：1101 不累积到持久性停投，与 707 各自独立', () => {
  // 混着来：2 次 707 + 5 次 1101。若 1101 也累加 rejectStreak，这里会误停投。
  recordSiderRejection(MODEL, 707, T0);
  // 拉开间隔越过合并窗口，确保这里测的是「1101 不污染 rejectStreak」本身
  for (let i = 0; i < 5; i += 1) recordSiderConcurrencyLimit(MODEL, T0 + i * 2_000);
  recordSiderRejection(MODEL, 707, T0);

  assertEquals(getSiderThrottleSnapshot(T0)[0]?.cooldownMs, 0, '两类失败混合后的停投状态');

  // 第 3 次 707 仍应正常触发停投——1101 既不加速也不阻碍它
  recordSiderRejection(MODEL, 707, T0);
  assertEquals(getSiderThrottleSnapshot(T0)[0]?.cooldownMs, 5 * 60_000, '第 3 次 707 后停投');
});

throttleTest('限流器：探测被并发挤掉不算探测失败，退避不翻倍且能再探', () => {
  for (let i = 0; i < 3; i += 1) recordSiderQuotaExhausted(MODEL, T0);

  const probeTime = T0 + 31_000;
  consumeSiderSlot(MODEL, probeTime);
  // 探测撞上并发限流：那是上游容量问题，没有证明"额度还没回来"
  recordSiderConcurrencyLimit(MODEL, probeTime);

  assertEquals(getSiderThrottleSnapshot(probeTime)[0]?.cooldownMs, 0, '退避不该翻倍');
  // probeInFlight 必须放掉，否则这个模型再也不会放行下一个探测
  assertEquals(canUseSider(MODEL, 100, probeTime + 60_000).ok, true, '仍可放行下一个探测');
});

throttleTest('限流器：快照带出最近一次并发限流时刻', () => {
  recordSiderConcurrencyLimit(MODEL, T0);
  assertEquals(getSiderThrottleSnapshot(T0)[0]?.lastConcurrencyAt, T0, '最近并发限流时刻');
});
