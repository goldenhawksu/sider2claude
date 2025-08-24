

/**
 * Sider2API - 将 Sider AI API 转换为 Anthropic API 格式
 * 
 * 目标: 为 Claude Code CLI 提供 Anthropic API 兼容接口
 * 技术栈: Hono + Bun
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { consola } from 'consola';

const app = new Hono();
const PORT = process.env.PORT || 4141;

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
    service: 'sider2api',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    tech_stack: 'hono + bun',
  });
});

// 根路径信息
app.get('/', (c) => {
  return c.json({
    name: 'Sider2API',
    description: 'Convert Sider AI API to Anthropic API format for Claude Code compatibility',
    version: '1.0.0',
    tech_stack: 'hono + bun',
    endpoints: {
      health: '/health',
      messages: '/v1/messages',
    },

  });
});

// 404 处理
app.notFound((c) => {
  return c.json({ error: 'Not Found' }, 404);
});

// 错误处理
app.onError((err, c) => {
  consola.error('Server error:', err);
  return c.json({ error: 'Internal Server Error' }, 500);
});

// 启动服务器
consola.info(`🚀 Sider2API server starting on port ${PORT}`);
consola.info(`📋 Health check: http://localhost:${PORT}/health`);
consola.info(`📖 API info: http://localhost:${PORT}/`);

export default {
  port: PORT,
  fetch: app.fetch,
};
