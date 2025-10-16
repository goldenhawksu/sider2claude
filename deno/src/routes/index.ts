

/**
 * 路由入口文件
 * 统一注册所有 API 路由
 */

import { Hono } from 'hono';

// 将来导入具体路由
// import { messagesRouter } from './messages.ts';
// import { modelsRouter } from './models.ts';

const router = new Hono();

// 暂时添加一个测试路由
router.get('/test', (c) => {
  return c.json({
    message: 'Route structure is working',
    timestamp: new Date().toISOString(),
  });
});

// TODO: 注册具体路由
// router.route('/v1/messages', messagesRouter);
// router.route('/v1/models', modelsRouter);

export { router };
