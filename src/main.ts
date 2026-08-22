

/**
 * Sider2Claude - 将 Sider AI API 转换为 Anthropic API 格式
 * 
 * 目标: 为 Claude Code CLI 提供 Anthropic API 兼容接口
 * 技术栈: Hono + Bun
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { consola } from 'consola';
import { hybridMessagesRouter } from './routes/messages-hybrid'; // 使用混合路由
import modelsRouter from './routes/models';
import completeRouter from './routes/complete';
import protocolRouter from './routes/protocols';
import { router } from './routes';
import { getEnv } from './utils/env';
import { getStatsSnapshot } from './utils/usage-stats';
import { renderStatsPage } from './utils/stats-page';

const app = new Hono();
const PORT = getEnv('PORT', '4141');

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
    version: '1.0.0-2025.10.17',
    timestamp: new Date().toISOString(),
    tech_stack: 'hono + bun',
  });
});

// 根路径信息
app.get('/', async (c) => {
  return c.json({
    name: 'Sider2Claude',
    description: 'Convert Sider AI API to Anthropic API format for Claude Code compatibility',
    version: '1.0.0',
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

// 注册 API 路由
app.route('/v1/models', modelsRouter);
app.route('/v1/messages', hybridMessagesRouter); // 使用混合路由
app.route('/v1/complete', completeRouter);
app.route('/', protocolRouter);
app.route('/api', router); // 测试路由

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
consola.info(`🚀 Sider2Claude server starting on port ${PORT}`);
consola.info(`📋 Health check: http://localhost:${PORT}/health`);
consola.info(`📖 API info: http://localhost:${PORT}/`);

export default {
  port: PORT,
  fetch: app.fetch,
};
