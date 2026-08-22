/**
 * 基础设施端点：健康检查、服务描述、后端状态、会话管理、404。
 * 这些端点不依赖上游，任何失败都是本服务问题。
 */

import {
  assertEquals,
  assertStatus,
  assertTrue,
  bailIfUpstreamLimited,
  type Suite,
} from '../harness.ts';

export const suite: Suite = {
  id: '01',
  title: '基础设施端点',
  cases: [
    {
      name: 'GET /health 返回 ok',
      async run({ api }) {
        const res = await api.get('/health', {});
        assertStatus(res, 200);
        assertEquals(res.json?.status, 'ok', 'status');
        assertTrue(!!res.json?.version, 'version 非空');
        return `version=${res.json.version} runtime=${res.json.runtime ?? 'n/a'}`;
      },
    },
    {
      name: 'GET / 声明端点与能力',
      async run({ api }) {
        const res = await api.get('/', {});
        assertStatus(res, 200);
        const endpoints = Object.keys(res.json?.endpoints ?? {});
        assertTrue(endpoints.length > 0, 'endpoints 非空');
        assertTrue(res.json?.features?.hybrid_routing === true, 'hybrid_routing 已开启');
        return `声明端点=${endpoints.length} backends=${JSON.stringify(res.json.features.backends)}`;
      },
    },
    {
      name: 'GET / 返回用量统计且结构完整',
      async run({ api }) {
        const res = await api.get('/', {});
        assertStatus(res, 200);
        const usage = res.json?.usage;
        assertTrue(!!usage, 'usage 字段存在');
        assertTrue(typeof usage.totals?.requests === 'number', 'totals.requests 是数字');
        assertTrue(typeof usage.backendShare?.sider === 'string', 'backendShare.sider 是字符串');
        assertTrue(Array.isArray(usage.tools), 'tools 是数组');
        assertTrue(Array.isArray(usage.recent), 'recent 是数组');
        assertTrue(typeof usage.lastHour?.requests === 'number', 'lastHour.requests 是数字');
        assertTrue(!!usage.since && !!usage.note, 'since 与 note 非空');
        return `requests=${usage.totals.requests} sider=${usage.backendShare.sider} ` +
          `deepseek=${usage.backendShare.deepseek} tools=${usage.tools.length}`;
      },
    },
    {
      name: '用量统计随真实请求增长并记录后端',
      async run({ api, config }) {
        const before = (await api.get('/', {})).json.usage.totals.requests;

        const chat = await api.post('/v1/messages', {
          model: config.liveModel,
          max_tokens: 64,
          messages: [{ role: 'user', content: '只回答一个词：中国的首都是哪里？' }],
        });
        bailIfUpstreamLimited(chat, '用量统计用例上游限流');
        assertStatus(chat, 200);

        const usage = (await api.get('/', {})).json.usage;
        assertTrue(
          usage.totals.requests > before,
          `请求计数增长（before=${before} after=${usage.totals.requests}）`,
        );
        assertTrue(usage.recent.length > 0, 'recent 有记录');

        const latest = usage.recent[0];
        assertTrue(
          latest.backend === 'sider' || latest.backend === 'deepseek',
          `最近一条记录了后端（实际 ${latest.backend}）`,
        );
        assertTrue(typeof latest.ms === 'number', '记录了耗时');
        return `最近一次由 ${latest.backend} 完成，model=${latest.model} 耗时=${latest.ms}ms`;
      },
    },
    {
      name: 'GET /v1/messages/backends/status',
      async run({ api }) {
        const res = await api.get('/v1/messages/backends/status');
        assertStatus(res, 200);
        const backends = res.json?.backends ?? {};
        assertTrue('sider' in backends && 'deepseek' in backends, '两个后端都有状态');
        return `sider=${backends.sider?.available} deepseek=${backends.deepseek?.available} ` +
          `autoFallback=${res.json?.routing?.autoFallback}`;
      },
    },
    {
      name: 'GET /v1/messages/conversations',
      async run({ api }) {
        const res = await api.get('/v1/messages/conversations');
        assertStatus(res, 200);
        assertEquals(res.json?.status, 'ok', 'status');
        return `totalConversations=${res.json?.conversations?.totalConversations ?? 'n/a'}`;
      },
    },
    {
      name: 'GET /v1/messages/sider-sessions',
      async run({ api }) {
        const res = await api.get('/v1/messages/sider-sessions');
        assertStatus(res, 200);
        assertEquals(res.json?.status, 'ok', 'status');
        return `totalSessions=${res.json?.sider_sessions?.totalSessions ?? 'n/a'}`;
      },
    },
    {
      name: 'POST .../conversations/cleanup 同时回收路由会话',
      async run({ api }) {
        const res = await api.post('/v1/messages/conversations/cleanup', {});
        assertStatus(res, 200);
        // 路由的会话后端记忆过去只增不减，现在随对话清理一并回收。
        assertTrue(
          typeof res.json?.cleanedRoutingSessions === 'number',
          'cleanedRoutingSessions 是数字',
        );
        return `conversations=${res.json.cleanedConversations} routingSessions=${res.json.cleanedRoutingSessions}`;
      },
    },
    {
      name: 'POST .../sider-sessions/cleanup',
      async run({ api }) {
        const res = await api.post('/v1/messages/sider-sessions/cleanup', {});
        assertStatus(res, 200);
        return `cleaned=${res.json?.cleanedSiderSessions ?? 0}`;
      },
    },
    {
      name: '未知路径返回 404',
      async run({ api }) {
        const res = await api.get('/definitely-not-a-route', {});
        assertStatus(res, 404);
        return 'HTTP 404';
      },
    },
  ],
};
