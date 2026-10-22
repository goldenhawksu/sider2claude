import { closeStatsKv } from '../src/utils/usage-stats-kv.ts';
import { resetRuntimeStrategy } from '../src/utils/runtime-strategy.ts';

function equal(actual: unknown, expected: unknown) {
  if (actual !== expected) throw new Error(`期望${expected}，实际${actual}`);
}

Deno.test({
  name: 'P0管理接口：开关鉴权、类型校验、落库及冷实例有效状态一致',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const vars = {
      AUTH_TOKEN: 'p0-admin',
      SIDER_AUTH_TOKEN: 'unused',
      SIDER_CONTROLLER: 'true',
      SIDER_CONTROLLER_STREAMING: 'false',
      STATS_KV: 'memory',
    };
    const previous = new Map(Object.keys(vars).map((key) => [key, Deno.env.get(key)]));
    for (const [key, value] of Object.entries(vars)) Deno.env.set(key, value);
    await closeStatsKv();
    resetRuntimeStrategy();
    try {
      const { default: app } = await import('../main.ts?p0-admin');
      const request = (body: unknown, auth = true) =>
        app.fetch(
          new Request('http://localhost/stats/strategy', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(auth ? { 'x-api-key': 'p0-admin' } : {}),
            },
            body: JSON.stringify(body),
          }),
        );
      equal((await request({ strategy: 'pro', controllerStreaming: true }, false)).status, 401);
      equal((await request({ strategy: 'pro', controllerStreaming: 'true' })).status, 400);
      equal((await request({ strategy: 'pro', controllerStreaming: true })).status, 200);
      resetRuntimeStrategy();
      const status = await (await app.fetch(
        new Request('http://localhost/v1/messages/backends/status', {
          headers: { 'x-api-key': 'p0-admin' },
        }),
      )).json();
      equal(status.routing.siderControllerStreaming, true);
      const stats = await (await app.fetch(new Request('http://localhost/stats.json'))).json();
      equal(stats.controller.streaming, true);
      equal((await request({ strategy: 'pro', controllerStreaming: false })).status, 200);
      const disabled = await (await app.fetch(
        new Request('http://localhost/v1/messages/backends/status', {
          headers: { 'x-api-key': 'p0-admin' },
        }),
      )).json();
      equal(disabled.routing.siderControllerStreaming, false);
      await closeStatsKv();
      Deno.env.set('STATS_KV', '');
      equal((await request({ strategy: 'pro', controllerStreaming: true })).status, 503);
      const unchanged = await (await app.fetch(
        new Request('http://localhost/v1/messages/backends/status', {
          headers: { 'x-api-key': 'p0-admin' },
        }),
      )).json();
      equal(unchanged.routing.siderControllerStreaming, false);
    } finally {
      await closeStatsKv();
      resetRuntimeStrategy();
      for (const [key, value] of previous) {
        if (value === undefined) Deno.env.delete(key);
        else Deno.env.set(key, value);
      }
    }
  },
});
