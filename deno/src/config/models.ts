/**
 * 模型配置
 * 定义所有支持的模型及其映射关系
 */

export interface ModelInfo {
  id: string; // Anthropic 格式的模型 ID
  object: 'model';
  created: number; // Unix 时间戳
  owned_by: string;
  siderModel?: string; // 对应的 Sider 模型（如果有映射）
}

/**
 * 支持的模型列表
 * 按照 OpenAI API 格式定义
 */
export const SUPPORTED_MODELS: ModelInfo[] = [
  // Claude 3.7 系列
  {
    id: 'claude-3.7-sonnet',
    object: 'model',
    created: 1677649963,
    owned_by: 'anthropic',
    siderModel: 'claude-3.7-sonnet',
  },
  {
    id: 'claude-3-7-sonnet',
    object: 'model',
    created: 1677649963,
    owned_by: 'anthropic',
    siderModel: 'claude-3.7-sonnet-think',
  },

  // Claude 4 系列
  {
    id: 'claude-4-sonnet',
    object: 'model',
    created: 1677649963,
    owned_by: 'anthropic',
    siderModel: 'claude-4-sonnet',
  },
  {
    id: 'claude-4-sonnet-think',
    object: 'model',
    created: 1677649963,
    owned_by: 'anthropic',
    siderModel: 'claude-4-sonnet-think',
  },
  {
    id: 'claude-4.1-opus',
    object: 'model',
    created: 1677649963,
    owned_by: 'anthropic',
    siderModel: 'claude-4.1-opus',
  },
  {
    id: 'claude-4.1-opus-think',
    object: 'model',
    created: 1677649963,
    owned_by: 'anthropic',
    siderModel: 'claude-4.1-opus-think',
  },
  {
    id: 'claude-4.5-sonnet',
    object: 'model',
    created: 1677649963,
    owned_by: 'anthropic',
    siderModel: 'claude-4.5-sonnet',
  },
  {
    id: 'claude-4.5-sonnet-think',
    object: 'model',
    created: 1677649963,
    owned_by: 'anthropic',
    siderModel: 'claude-4.5-sonnet-think',
  },
  {
    id: 'claude-haiku-4.5',
    object: 'model',
    created: 1677649963,
    owned_by: 'anthropic',
    siderModel: 'claude-haiku-4.5',
  },
  {
    id: 'claude-haiku-4.5-think',
    object: 'model',
    created: 1677649963,
    owned_by: 'anthropic',
    siderModel: 'claude-haiku-4.5-think',
  },
  // 通用别名
  {
    id: 'claude-3-sonnet',
    object: 'model',
    created: 1677649963,
    owned_by: 'anthropic',
    siderModel: 'claude-3.7-sonnet-think',
  },
  {
    id: 'claude-sonnet',
    object: 'model',
    created: 1677649963,
    owned_by: 'anthropic',
    siderModel: 'claude-4.5-sonnet-think',
  },
];

/**
 * 模型映射表：Anthropic → Sider
 */
export const MODEL_MAP: Record<string, string> = SUPPORTED_MODELS.reduce((acc, model) => {
  if (model.siderModel) {
    acc[model.id.toLowerCase()] = model.siderModel;
  }
  return acc;
}, {} as Record<string, string>);

/**
 * 获取所有支持的模型列表
 */
export function getAllModels(): ModelInfo[] {
  return SUPPORTED_MODELS;
}

/**
 * 根据 ID 获取模型信息
 */
export function getModelById(id: string): ModelInfo | undefined {
  return SUPPORTED_MODELS.find(m => m.id.toLowerCase() === id.toLowerCase());
}

/**
 * 映射模型名称：Anthropic → Sider
 */
export function mapModelName(anthropicModel: string): string {
  // 查找映射
  const mapped = MODEL_MAP[anthropicModel.toLowerCase()];
  if (mapped) {
    return mapped;
  }

  // 如果包含 think，直接使用
  if (anthropicModel.includes('think')) {
    return anthropicModel;
  }

  // 默认返回 claude-4.5-sonnet
  console.warn('Unknown model, using default:', {
    requested: anthropicModel,
    fallback: 'claude-4.5-sonnet',
  });

  return 'claude-4.5-sonnet';
}

/**
 * 检查模型是否支持
 */
export function isModelSupported(modelId: string): boolean {
  return !!getModelById(modelId);
}
