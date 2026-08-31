/**
 * Sider 调用运行遥测。
 *
 * 遥测是旁路分析数据，三条取向各自有测试守着：
 * 1. 逐条写入 `['tele', hourBucket, ts]`，零竞争、无需 CAS；
 * 2. 容量硬上限靠**写入端节流**（每实例每小时最多 40 条），不靠读时裁剪——
 *    后者需要计数器读改写，会把零竞争的写路径拖回协调瓶颈；
 * 3. 回收走确定性扫描删旧桶，不用 `expireIn`（实测 `:memory:` KV 上不生效）。
 *
 * 与 usage-stats-kv 测试同一套路：`withMemoryKv` + `waitFor` 轮询，不用固定
 * `setTimeout`（fire-and-forget 落库时机随负载浮动，固定等待会让门禁偶发变红）。
 */

import {
  aggregateSiderHealth,
  persistSiderTelemetry,
  readSiderTelemetry,
  resetSiderTelemetry,
} from '../src/utils/sider-telemetry.ts';
import { closeStatsKv } from '../src/utils/usage-stats-kv.ts';

function assertEquals<T>(actual: T, expected: T, what = '值') {
  if (actual !== expected) {
    throw new Error(`${what}：期望 ${String(expected)}，实际 ${String(actual)}`);
  }
}

async function withMemoryKv(fn: () => Promise<void>): Promise<void> {
  const prev = Deno.env.get('STATS_KV');
  Deno.env.set('STATS_KV', 'memory');
  await closeStatsKv();
  try {
    await fn();
  } finally {
    await closeStatsKv();
    if (prev === undefined) Deno.env.delete('STATS_KV');
    else Deno.env.set('STATS_KV', prev);
  }
}

async function waitFor(
  ready: () => Promise<boolean>,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await ready()) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const BASE = 1_700_000_000_000;

Deno.test({
  name: '遥测：逐条写入并可读回白名单字段',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withMemoryKv(async () => {
      resetSiderTelemetry();
      persistSiderTelemetry({
        ts: BASE,
        model: 'claude-sonnet-5',
        strategy: 'max',
        payloadChars: 500,
        ok: true,
        siderCode: 0,
        ms: 320,
        hasTools: true,
        restoredToolUse: true,
      });

      let records: Awaited<ReturnType<typeof readSiderTelemetry>> = [];
      await waitFor(async () => {
        records = await readSiderTelemetry(BASE + 1);
        return records.length === 1;
      });

      assertEquals(records.length, 1, '条数');
      const r = records[0]!;
      assertEquals(r.model, 'claude-sonnet-5', '模型');
      assertEquals(r.strategy, 'max', '策略');
      assertEquals(r.ok, true, '结果');
      assertEquals(r.restoredToolUse, true, '是否还原 tool_use');
    });
  },
});

Deno.test({
  name: '遥测：每小时写入有硬上限，超过即丢弃',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withMemoryKv(async () => {
      resetSiderTelemetry();
      // 同一小时写 100 条，最多只该留 40 条
      for (let i = 0; i < 100; i += 1) {
        persistSiderTelemetry({
          ts: BASE + i,
          model: 'claude-sonnet-5',
          strategy: 'pro',
          payloadChars: 100,
          ok: true,
          siderCode: 0,
          ms: 10,
          hasTools: false,
          restoredToolUse: false,
        });
      }

      let records: Awaited<ReturnType<typeof readSiderTelemetry>> = [];
      await waitFor(async () => {
        records = await readSiderTelemetry(BASE + 200);
        return records.length > 0;
      });
      // 写入是 fire-and-forget，等队列排空后再断言最终条数
      await new Promise((resolve) => setTimeout(resolve, 100));
      records = await readSiderTelemetry(BASE + 200);
      assertEquals(records.length <= 40, true, `条数上限，实际 ${records.length}`);
    });
  },
});

Deno.test({
  name: '遥测：旧桶在读取扫描时回收',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withMemoryKv(async () => {
      resetSiderTelemetry();
      // 25 小时前的旧记录，加上一条当前记录
      persistSiderTelemetry({
        ts: BASE - 25 * 60 * 60_000,
        model: 'claude-opus-4.8',
        strategy: 'conservative',
        payloadChars: 100,
        ok: false,
        siderCode: 1135,
        ms: 500,
        hasTools: false,
        restoredToolUse: false,
      });
      persistSiderTelemetry({
        ts: BASE,
        model: 'claude-sonnet-5',
        strategy: 'pro',
        payloadChars: 100,
        ok: true,
        siderCode: 0,
        ms: 10,
        hasTools: false,
        restoredToolUse: false,
      });

      await waitFor(async () => (await readSiderTelemetry(BASE + 1)).length === 1);
      const records = await readSiderTelemetry(BASE + 1);
      assertEquals(records.length, 1, '旧记录被回收');
      assertEquals(records[0]!.model, 'claude-sonnet-5', '只留窗口内记录');
    });
  },
});

// ── 看板聚合 ────────────────────────────────────────────────────────────────
//
// 生产上限流器那张表长期为空：它是进程内状态，而 Deploy 多实例 + 空闲回收让
// `/stats` 的快照几乎必然落在没有碰撞记录的实例上。遥测已经在 KV 里，聚合出来
// 正好补这个观测缺口。下面锁定聚合口径与扫描范围。

/** 写一条遥测的简写，只暴露聚合关心的字段。 */
function tele(
  ts: number,
  model: string,
  ok: boolean,
  siderCode = 0,
  ms = 100,
): void {
  persistSiderTelemetry({
    ts,
    model,
    strategy: 'pro',
    payloadChars: 100,
    ok,
    siderCode,
    ms,
    hasTools: false,
    restoredToolUse: false,
  });
}

Deno.test({
  name: '遥测聚合：按模型汇总成功/失败与最近错误码',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withMemoryKv(async () => {
      resetSiderTelemetry();
      tele(BASE, 'claude-sonnet-5', true, 0, 200);
      tele(BASE + 1, 'claude-sonnet-5', true, 0, 400);
      tele(BASE + 2, 'claude-sonnet-5', false, 1135);
      // fable-5 恒失败，正是线上实测的 707 形态
      tele(BASE + 3, 'claude-fable-5', false, 707);
      tele(BASE + 4, 'claude-fable-5', false, 707);

      let rows: Awaited<ReturnType<typeof aggregateSiderHealth>> = [];
      await waitFor(async () => {
        rows = await aggregateSiderHealth(BASE + 10);
        return rows.length === 2;
      });

      // 失败多的排前面：这张卡是用来发现问题的
      const fable = rows[0]!;
      assertEquals(fable.model, 'claude-fable-5', '排序首行');
      assertEquals(fable.attempts, 2, 'fable 尝试数');
      assertEquals(fable.ok, 0, 'fable 成功数');
      assertEquals(fable.failed, 2, 'fable 失败数');
      assertEquals(fable.lastCode, 707, 'fable 最近错误码');
      assertEquals(fable.lastFailedAt, BASE + 4, 'fable 最近失败时刻');
      assertEquals(fable.avgMs, 0, '无成功时平均耗时为 0');

      const sonnet = rows[1]!;
      assertEquals(sonnet.attempts, 3, 'sonnet 尝试数');
      assertEquals(sonnet.ok, 2, 'sonnet 成功数');
      assertEquals(sonnet.failed, 1, 'sonnet 失败数');
      assertEquals(sonnet.lastCode, 1135, 'sonnet 最近错误码');
      // 平均耗时只算成功的那些：(200 + 400) / 2
      assertEquals(sonnet.avgMs, 300, 'sonnet 成功平均耗时');
    });
  },
});

Deno.test({
  name: '遥测聚合：只扫最近若干小时桶，不读满整个保留窗口',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withMemoryKv(async () => {
      resetSiderTelemetry();
      const hour = 60 * 60_000;
      // 5 小时前的记录落在扫描范围外——/stats 每 5 秒刷新一次，
      // 全量扫描会让这张卡的开销随实例数线性增长。
      tele(BASE - 5 * hour, 'old-model', true);
      tele(BASE, 'fresh-model', true);

      let rows: Awaited<ReturnType<typeof aggregateSiderHealth>> = [];
      await waitFor(async () => {
        rows = await aggregateSiderHealth(BASE + 10, 2);
        return rows.length > 0;
      });

      assertEquals(rows.length, 1, '仅窗口内模型');
      assertEquals(rows[0]!.model, 'fresh-model', '窗口内模型');
    });
  },
});

Deno.test({
  name: '遥测聚合：KV 未启用时返回空数组而非抛错',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // 未设 STATS_KV = 完全跳过 KV。看板永远不能因为遥测不可用而崩掉。
    const prev = Deno.env.get('STATS_KV');
    Deno.env.delete('STATS_KV');
    await closeStatsKv();
    try {
      const rows = await aggregateSiderHealth(BASE);
      assertEquals(rows.length, 0, 'KV 未启用时的行数');
    } finally {
      await closeStatsKv();
      if (prev !== undefined) Deno.env.set('STATS_KV', prev);
    }
  },
});
