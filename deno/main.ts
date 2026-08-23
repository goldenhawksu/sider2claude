/**
 * Sider2Claude - Deno Deploy 版本
 *
 * 将 Sider AI API 转换为 Anthropic API 格式
 * 目标: 为 Claude Code CLI 提供 Anthropic API 兼容接口
 * 技术栈: Hono + Deno
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { hybridMessagesRouter } from './src/routes/messages-hybrid.ts';
import modelsRouter from './src/routes/models.ts';
import completeRouter from './src/routes/complete.ts';
import protocolRouter from './src/routes/protocols.ts';
import { getEnv } from './src/utils/env.ts';
import { getStatsSnapshot } from './src/utils/usage-stats.ts';
import { renderStatsPage } from './src/utils/stats-page.ts';
import { setSiderStrategy } from './src/utils/runtime-strategy.ts';
import { readSiderTelemetry } from './src/utils/sider-telemetry.ts';

const app = new Hono();

// 环境变量 - Deno Deploy 方式
const PORT = parseInt(getEnv('PORT', '8000'), 10);

// 中间件
app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  }),
);

app.use('*', logger());

// 健康检查端点
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'sider2claude',
    version: '1.0.0-2025.10.17-deno',
    timestamp: new Date().toISOString(),
    tech_stack: 'hono + deno',
    runtime: 'Deno Deploy',
  });
});

// 根路径信息
app.get('/', async (c) => {
  return c.json({
    name: 'Sider2Claude',
    description: 'Convert Sider AI API to Anthropic API format for Claude Code compatibility',
    version: '1.0.0-deno',
    tech_stack: 'hono + deno',
    runtime: 'Deno Deploy',
    endpoints: {
      health: '/health',
      stats: '/stats',
      models: '/v1/models',
      messages: '/v1/messages',
      openai_chat_completions: '/v1/chat/completions',
      openai_responses: '/v1/responses',
      gemini_generate_content: '/v1beta/models/{model}:generateContent',
      gemini_stream_generate_content: '/v1beta/models/{model}:streamGenerateContent',
      complete: '/v1/complete',
      count_tokens: '/v1/messages/count_tokens',
      conversations: '/v1/messages/conversations',
      sider_sessions: '/v1/messages/sider-sessions',
      backends_status: '/v1/messages/backends/status', // 新增混合路由状态端点
    },
    features: {
      hybrid_routing: true, // 启用混合路由
      backends: ['sider', 'deepseek'],
      capability_fallback: 'deepseek',
    },
    usage: await getStatsSnapshot(),
  });
});

// 用量看板：/stats 返回 HTML 页面，/stats.json 返回同一份快照的原始数据
app.get('/stats', async (c) => {
  return c.html(renderStatsPage(await getStatsSnapshot()));
});

app.get('/stats.json', async (c) => {
  return c.json(await getStatsSnapshot());
});

// 网页切换调度策略。用户已明确不考虑安全问题，故不挂 requireAuth。
// 写进 KV 让多实例最多 3 秒收敛；当前实例立即生效。
app.post('/stats/strategy', async (c) => {
  const body = await c.req.json().catch(() => ({})) as { strategy?: unknown };
  const strategy = body.strategy;
  if (strategy !== 'conservative' && strategy !== 'pro' && strategy !== 'max') {
    return c.json({ error: `invalid strategy: ${String(strategy)}` }, 400);
  }
  setSiderStrategy(strategy);
  return c.json({ status: 'ok', strategy });
});

// 运行遥测原始记录，供离线分析优化调度策略。
app.get('/stats/telemetry.json', async (c) => {
  return c.json({ records: await readSiderTelemetry() });
});

// 注册 API 路由
app.route('/v1/models', modelsRouter);
app.route('/v1/messages', hybridMessagesRouter); // 使用混合路由
app.route('/v1/complete', completeRouter);
app.route('/', protocolRouter);

// 404 处理
app.notFound((c) => {
  return c.json({ error: 'Not Found' }, 404);
});

// 错误处理
app.onError((err, c) => {
  console.error('Server error:', err);
  return c.json({ error: 'Internal Server Error', message: err.message }, 500);
});

// Deno Deploy 导出（新平台不接受显式端口，由平台自动分配）
export default {
  fetch: app.fetch,
};

// 本地开发服务器
if (import.meta.main) {
  const PORT = parseInt(getEnv('PORT', '8000'), 10);
  console.log(`🚀 Sider2Claude server starting on port ${PORT}`);
  console.log(`📋 Health check: http://localhost:${PORT}/health`);
  console.log(`📖 API info: http://localhost:${PORT}/`);

  Deno.serve({ port: PORT }, app.fetch);
}
