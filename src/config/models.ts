/**
 * 模型配置。
 *
 * 这里维护的是对外暴露给 Claude Code 的 Anthropic 模型名，以及这些模型
 * 在 Sider 服务端的真实模型名。模型清单以 Sider probe 结果为依据更新。
 */

export interface ModelInfo {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
  siderModel: string;
}

const MODEL_CREATED_AT = 1677649963;

function model(id: string, siderModel = id): ModelInfo {
  return {
    id,
    object: 'model',
    created: MODEL_CREATED_AT,
    owned_by: 'anthropic',
    siderModel,
  };
}

/**
 * 支持的模型列表。
 *
 * 说明：
 * - `claude-opus-4.5*` 是对外兼容别名，当前映射到 Sider 的 `claude-opus-4.6*`。
 * - `claude-3-sonnet`、`claude-sonnet` 是面向旧配置和简写场景的通用别名。
 */
export const SUPPORTED_MODELS: ModelInfo[] = [
  model('claude-3.7-sonnet'),
  model('claude-3-7-sonnet', 'claude-3.7-sonnet-think'),
  model('claude-4-sonnet'),
  model('claude-4-sonnet-think'),
  model('claude-4.1-opus'),
  model('claude-4.1-opus-think'),
  model('claude-opus-4.5', 'claude-opus-4.6'),
  model('claude-opus-4.5-think', 'claude-opus-4.6-think'),
  model('claude-opus-4.6'),
  model('claude-opus-4.6-think'),
  model('claude-4.5-sonnet'),
  model('claude-4.5-sonnet-think'),
  model('claude-sonnet-4.6'),
  model('claude-sonnet-4.6-think'),
  model('claude-haiku-4.5'),
  model('claude-haiku-4.5-think'),
  model('claude-3-sonnet', 'claude-3.7-sonnet-think'),
  model('claude-sonnet', 'claude-sonnet-4.6'),
];

/**
 * 模型映射表：Anthropic -> Sider。
 */
export const MODEL_MAP: Record<string, string> = SUPPORTED_MODELS.reduce((acc, modelInfo) => {
  acc[modelInfo.id.toLowerCase()] = modelInfo.siderModel;
  return acc;
}, {} as Record<string, string>);

export function getAllModels(): ModelInfo[] {
  return SUPPORTED_MODELS;
}

export function getModelById(id: string): ModelInfo | undefined {
  return SUPPORTED_MODELS.find((modelInfo) => modelInfo.id.toLowerCase() === id.toLowerCase());
}

/**
 * 映射模型名称：Anthropic -> Sider。
 *
 * 未显式登记的 Claude 族模型按模型家族保守映射到已探测过的 Sider 模型。
 */
export function mapModelName(anthropicModel: string): string {
  const normalizedModel = anthropicModel.toLowerCase();
  const mapped = MODEL_MAP[normalizedModel];
  if (mapped) {
    return mapped;
  }

  if (normalizedModel.includes('opus')) {
    return normalizedModel.includes('think') ? 'claude-opus-4.6-think' : 'claude-opus-4.6';
  }

  if (normalizedModel.includes('haiku')) {
    return normalizedModel.includes('think') ? 'claude-haiku-4.5-think' : 'claude-haiku-4.5';
  }

  if (normalizedModel.includes('sonnet')) {
    return normalizedModel.includes('think') ? 'claude-sonnet-4.6-think' : 'claude-sonnet-4.6';
  }

  console.warn('Unknown Claude model, using Sider default:', {
    requested: anthropicModel,
    fallback: 'claude-sonnet-4.6',
  });
  return 'claude-sonnet-4.6';
}

export function isModelSupported(modelId: string): boolean {
  return !!getModelById(modelId);
}
