

/**
 * Sider2Claude - 将 Sider AI API 转换为 Anthropic API 格式
 * 
 * 目标: 为 Claude Code CLI 提供 Anthropic API 兼容接口
 * 技术栈: Hono + Bun
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { bodyLimit } from 'hono/body-limit';
import { consola } from 'consola';
import { hybridMessagesRouter } from './routes/messages-hybrid'; // 使用混合路由
import modelsRouter from './routes/models';
import completeRouter from './routes/complete';
import protocolRouter from './routes/protocols';
import { getEnv } from './utils/env';
import { getStatsSnapshot } from './utils/usage-stats';
import { renderStatsPage } from './utils/stats-page';
import { requireStatsAuth, statsLogin, statsLogout } from './middleware/stats-auth';

const app = new Hono();
const PORT = getEnv('PORT', '4141');

// 中间件
app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
  if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
});

// 与 Deno 侧一致：浏览器端用 x-api-key 鉴权时预检必须放行该头。
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: [
    'Content-Type',
    'Authorization',
    'X-API-Key',
    'Anthropic-Version',
    'Anthropic-Beta',
    'X-Conversation-ID',
    'X-Parent-Message-ID',
    'X-Request-ID',
  ],
  exposeHeaders: [
    'X-Conversation-ID',
    'X-Assistant-Message-ID',
    'X-User-Message-ID',
    'X-Request-ID',
    'X-Backend-Used',
    'X-Routing-Rule',
    'Retry-After',
  ],
}));

app.use('*', logger());

// 请求体上限与 Anthropic Messages API 一致（32 MB），可用 MAX_REQUEST_BODY_BYTES 调整。
const MAX_REQUEST_BODY_BYTES = (() => {
  const parsed = Number(getEnv('MAX_REQUEST_BODY_BYTES'));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 32 * 1024 * 1024;
})();
app.use('*', bodyLimit({
  maxSize: MAX_REQUEST_BODY_BYTES,
  onError: (c) => c.json({
    type: 'error',
    error: { type: 'request_too_large', message: `Request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes` },
  }, 413),
}));

const SERVICE_VERSION = '1.0.0';

// 健康检查端点
app.get('/health', (c) => {
  return c.json({ 
    status: 'ok', 
    service: 'sider2claude',
    version: SERVICE_VERSION,
    timestamp: new Date().toISOString(),
    tech_stack: 'hono + bun',
  });
});

// 根路径信息（不含用量数据：用量在需要鉴权的 /stats.json）
app.get('/', (c) => {
  return c.json({
    name: 'Sider2Claude',
    description: 'Convert Sider AI API to Anthropic API format for Claude Code compatibility',
    version: SERVICE_VERSION,
    tech_stack: 'hono + bun',
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
      backends_status: '/v1/messages/backends/status',
    },
    features: {
      hybrid_routing: true,
      backends: ['sider', 'deepseek'],
      capability_fallback: 'deepseek',
    },
  });
});

// 用量看板：需要看板凭证（请求头或登录 cookie），STATS_PUBLIC=true 可恢复公开。
app.post('/stats/login', statsLogin);
app.post('/stats/logout', statsLogout);

app.get('/stats', requireStatsAuth, async (c) => {
  return c.html(renderStatsPage(await getStatsSnapshot()));
});

app.get('/stats.json', requireStatsAuth, async (c) => {
  return c.json(await getStatsSnapshot());
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
  const requestId = c.req.header('X-Request-ID') || crypto.randomUUID();
  consola.error('Server error:', { requestId, error: err });
  return c.json({
    type: 'error',
    error: { type: 'api_error', message: 'Internal Server Error', request_id: requestId },
  }, 500);
});

// 启动服务器
consola.info(`🚀 Sider2Claude server starting on port ${PORT}`);
consola.info(`📋 Health check: http://localhost:${PORT}/health`);
consola.info(`📖 API info: http://localhost:${PORT}/`);

export default {
  port: PORT,
  // 实测默认10秒会与SSE心跳竞争；上游独立总期限仍限制请求生命周期。
  idleTimeout: 255,
  fetch: app.fetch,
};
