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
