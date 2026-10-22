import {
  getSiderActivitySnapshot,
  recordSiderActivity,
  resetSiderActivity,
} from '../src/utils/sider-activity.ts';
import {
  persistSiderTelemetry,
  readSiderTelemetry,
  resetSiderTelemetry,
} from '../src/utils/sider-telemetry.ts';
import { closeStatsKv, getKv } from '../src/utils/usage-stats-kv.ts';
import { getStatsSnapshot, recordUsage, resetSnapshotCache } from '../src/utils/usage-stats.ts';

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`期望${JSON.stringify(expected)}，实际${JSON.stringify(actual)}`);
  }
}

Deno.test({
  name: 'Sider计数：遥测写入失败不误报为已保留，调用聚合继续写入',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () =>
    withKv('memory', async () => {
      const kv = (await getKv())!;
      const original = kv.set.bind(kv);
      try {
        kv.set = ((key, value, options) =>
          key[0] === 'tele'
            ? Promise.reject(new Error('模拟明细写入失败'))
            : original(key, value, options)) as typeof kv.set;
        recordSiderActivity('claude-opus-5.5', { attempts: 1 });
        persistSiderTelemetry({
          ts: Date.now(),
          model: 'claude-opus-5.5',
          strategy: 'controller',
          payloadChars: 1,
          ok: true,
          siderCode: 0,
          ms: 1,
          hasTools: false,
          restoredToolUse: false,
        });
        const deadline = Date.now() + 8000;
        let snapshot;
        do {
          snapshot = await getSiderActivitySnapshot();
          if (snapshot.totals.telemetryDropped === 1) break;
          await new Promise((resolve) =>
            setTimeout(resolve, 10)
          );
        } while (Date.now() < deadline);
        equal(snapshot.totals.telemetryRecorded, 0);
        equal(snapshot.totals.telemetryDropped, 1);
        equal(snapshot.totals.attempts, 1);
      } finally {
        kv.set = original;
      }
    }),
});

async function withKv(mode: string, run: () => Promise<void>) {
  const previous = Deno.env.get('STATS_KV');
  await closeStatsKv();
  Deno.env.set('STATS_KV', mode);
  resetSiderActivity();
  resetSiderTelemetry();
  try {
    await run();
  } finally {
    await closeStatsKv();
    if (previous === undefined) Deno.env.delete('STATS_KV');
    else Deno.env.set('STATS_KV', previous);
    resetSiderActivity();
  }
}

Deno.test({
  name: 'Sider计数：分开统计调用、业务完成与登记，窗口标签合并且旧桶过期',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () =>
    withKv('', async () => {
      const now = Date.now();
      recordSiderActivity('claude-sonnet-5.5', { attempts: 100 }, now - 25 * 3600_000);
      recordSiderActivity(
        'claude-sonnet-5.5[1M]',
        { attempts: 2, succeeded: 2, contextUploads: 2 },
        now,
      );
      recordSiderActivity('claude-sonnet-5.5', {
        attempts: 2,
        succeeded: 1,
        failed: 1,
        quotaErrors: 1,
        completed: 1,
        requestFailures: 1,
        cachedReplays: 1,
      }, now);
      const snapshot = await getSiderActivitySnapshot(now);
      equal(snapshot.persisted, false);
      equal(snapshot.models.length, 1);
      equal(snapshot.models[0].model, 'claude-sonnet-5.5');
      equal(snapshot.totals.attempts, 4);
      equal(snapshot.totals.succeeded, 3);
      equal(snapshot.totals.failed, 1);
      equal(snapshot.totals.quotaErrors, 1);
      equal(snapshot.totals.contextUploads, 2);
      equal(snapshot.totals.completed, 1);
      equal(snapshot.totals.requestFailures, 1);
      equal(snapshot.totals.cachedReplays, 1);
    }),
});

Deno.test({
  name: 'Sider计数：遥测达到40条采样上限后聚合仍保留全部调用和失败',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () =>
    withKv('memory', async () => {
      const now = Date.now();
      for (let i = 0; i < 100; i++) {
        recordSiderActivity('claude-opus-5.5', { attempts: 1, failed: 1, quotaErrors: 1 }, now);
        persistSiderTelemetry({
          ts: now + i,
          model: 'claude-opus-5.5',
          strategy: 'controller',
          payloadChars: 100,
          ok: false,
          siderCode: 1135,
          ms: 10,
          hasTools: true,
          restoredToolUse: false,
        });
      }
      const deadline = Date.now() + 8000;
      let snapshot = await getSiderActivitySnapshot(now + 200);
      while (
        (snapshot.totals.attempts !== 100 || snapshot.totals.telemetryDropped !== 60) &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        snapshot = await getSiderActivitySnapshot(now + 200);
      }
      equal(snapshot.persisted, true);
      equal(snapshot.totals.attempts, 100);
      equal(snapshot.totals.quotaErrors, 100);
      equal(snapshot.totals.telemetryRecorded, 40);
      equal(snapshot.totals.telemetryDropped, 60);
      equal((await readSiderTelemetry(now + 200)).length, 40);
      resetSiderActivity();
      equal((await getSiderActivitySnapshot(now + 200)).totals.attempts, 100);
    }),
});

Deno.test({
  name: 'Sider计数：持久化最近记录保留实际模型、模式与部署，重启不猜测旧记录',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () =>
    withKv('memory', async () => {
      recordUsage({
        model: 'claude-opus-5.5',
        actualModel: 'glm-5.3-flash',
        mode: 'hybrid',
        routingRule: 'rule_2_claude_tools',
        deployment: 'p0-test',
        backend: 'deepseek',
        deepseekReason: 'tools',
        fallback: false,
        toolUses: ['Read'],
        stream: true,
        ms: 10,
        inputTokens: 12,
        outputTokens: 4,
      });
      const deadline = Date.now() + 8000;
      let snapshot;
      do {
        resetSnapshotCache();
        snapshot = await getStatsSnapshot();
        if (snapshot.recent[0]?.deployment === 'p0-test') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      } while (Date.now() < deadline);
      equal(snapshot.persisted, true);
      equal(snapshot.recent[0].actualModel, 'glm-5.3-flash');
      equal(snapshot.recent[0].mode, 'hybrid');
      equal(snapshot.recent[0].routingRule, 'rule_2_claude_tools');
      equal(snapshot.recent[0].deployment, 'p0-test');
      equal(snapshot.recent[0].stream, true);
      equal(snapshot.siderActivity?.totals.completed, 0);
    }),
});
