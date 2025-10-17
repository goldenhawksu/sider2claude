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
import { messagesRouter } from './src/routes/messages.ts';
import modelsRouter from './src/routes/models.ts';
import completeRouter from './src/routes/complete.ts';

const app = new Hono();

// 环境变量 - Deno Deploy 方式
const PORT = parseInt(Deno.env.get('PORT') || '8000');

// 中间件
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));

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
app.get('/', (c) => {
  return c.json({
    name: 'Sider2Claude',
    description: 'Convert Sider AI API to Anthropic API format for Claude Code compatibility',
    version: '1.0.0-deno',
    tech_stack: 'hono + deno',
    runtime: 'Deno Deploy',
    endpoints: {
      health: '/health',
      models: '/v1/models',
      messages: '/v1/messages',
      complete: '/v1/complete',
      count_tokens: '/v1/messages/count_tokens',
      conversations: '/v1/messages/conversations',
      sider_sessions: '/v1/messages/sider-sessions',
    },
  });
});

// 注册 API 路由
app.route('/v1/models', modelsRouter);
app.route('/v1/messages', messagesRouter);
app.route('/v1/complete', completeRouter);

// 404 处理
app.notFound((c) => {
  return c.json({ error: 'Not Found' }, 404);
});

// 错误处理
app.onError((err, c) => {
  console.error('Server error:', err);
  return c.json({ error: 'Internal Server Error', message: err.message }, 500);
});

// Deno Deploy 导出
export default {
  fetch: app.fetch,
};

// 本地开发服务器
if (import.meta.main) {
  console.log(`🚀 Sider2Claude server starting on port ${PORT}`);
  console.log(`📋 Health check: http://localhost:${PORT}/health`);
  console.log(`📖 API info: http://localhost:${PORT}/`);

  Deno.serve({ port: PORT }, app.fetch);
}
