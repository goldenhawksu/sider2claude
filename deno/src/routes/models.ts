/**
 * Models API 路由
 * 实现 OpenAI/Anthropic API 兼容的 /v1/models 端点
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { getAllModels, getModelById } from '../config/models.ts';

const modelsRouter = new Hono();

/**
 * GET /v1/models
 * 列出所有可用的模型
 */
modelsRouter.get('/', (c: Context) => {
  const models = getAllModels();

  return c.json({
    object: 'list',
    data: models,
  });
});

/**
 * GET /v1/models/:model_id
 * 获取特定模型的详细信息
 */
modelsRouter.get('/:model_id', (c: Context) => {
  const modelId = c.req.param('model_id');
  const model = getModelById(modelId);

  if (!model) {
    return c.json(
      {
        error: {
          message: `The model '${modelId}' does not exist`,
          type: 'invalid_request_error',
          param: 'model',
          code: 'model_not_found',
        },
      },
      404
    );
  }

  return c.json(model);
});

export default modelsRouter;
