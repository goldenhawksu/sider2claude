/**
 * 模型配置。
 *
 * 这里维护的是对外暴露给 Claude Code 的 Anthropic 模型名，以及这些模型
 * 在 Sider 服务端的真实模型名。模型清单以 Sider probe 结果和
 * 参考仓库 goldenhawksu/sider2api 的 deno_pro.ts MODEL_MAPPING 为依据。
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
 * 分为 Claude 主模型（Anthropic 对外接口）和扩展映射（来自 sider2api deno_pro.ts）。
 * Claude Code 通过 /v1/models 只看到 Claude 家族，但服务内部支持其他厂商的 Sider 转发。
 */

// ── Claude 家族（Anthropic Messages API 对外） ──
const CLAUDE_MODELS: ModelInfo[] = [
  // Opus 系列
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
  model('claude-opus-4.8', 'claude-opus-4.8'),
  model('claude-opus-4.8-think', 'claude-opus-4.8-think'),
  model('claude-fable-5', 'claude-fable-5'),
  model('claude-fable-5-think', 'claude-fable-5-think'),

  // Sonnet 系列
  model('claude-4.5-sonnet'),
  model('claude-4.5-sonnet-think'),
  model('claude-sonnet-4.6'),
  model('claude-sonnet-4.6-think'),

  // Haiku 系列
  model('claude-haiku-4.5'),
  model('claude-haiku-4.5-think'),

  // 别名
  model('claude-3-sonnet', 'claude-3.7-sonnet-think'),
  model('claude-sonnet', 'claude-sonnet-4.6'),
];

// ── Sider 全模型映射（参考 sider2api deno_pro.ts MODEL_MAPPING） ──
// 这些模型不在 Anthropic 对外接口中暴露，但为路由和 fallback 提供映射。
const SIDER_FULL_MAPPING: Record<string, string> = {
  // GPT 系列
  'gpt-4.1': 'gpt-4.1',
  'gpt-5': 'gpt-5',
  'gpt-5-think': 'gpt-5-think',
  'gpt-5-mini': 'gpt-5-mini',
  'gpt-5.1': 'gpt-5.1',
  'gpt-5.1-think': 'gpt-5.1-think',
  'gpt-5.4': 'gpt-5.4',
  'gpt-5.4-mini': 'gpt-5.4-mini',
  'gpt-5.4-think': 'gpt-5.4-think',
  'gpt-5.5': 'gpt-5.5',
  'gpt-5.5-think': 'gpt-5.5-think',

  // Claude 系列（对齐 sider2api 的命名风格）
  'claude-opus-4.5': 'claude-opus-4.5',
  'claude-opus-4.5-think': 'claude-opus-4.5-think',
  'claude-opus-4.6': 'claude-opus-4.6',
  'claude-opus-4.6-think': 'claude-opus-4.6-think',
  'claude-opus-4.8': 'claude-opus-4.8',
  'claude-opus-4.8-think': 'claude-opus-4.8-think',
  'claude-fable-5': 'claude-fable-5',
  'claude-fable-5-think': 'claude-fable-5-think',
  'claude-4.5-sonnet': 'claude-4.5-sonnet',
  'claude-4.5-sonnet-think': 'claude-4.5-sonnet-think',
  'claude-sonnet-4.6': 'claude-sonnet-4.6',
  'claude-sonnet-4.6-think': 'claude-sonnet-4.6-think',
  'claude-haiku-4.5': 'claude-haiku-4.5',
  'claude-haiku-4.5-think': 'claude-haiku-4.5-think',

  // Gemini 系列
  'gemini-2.5-pro': 'gemini-2.5-pro',
  'gemini-2.5-flash': 'gemini-2.5-flash',
  'gemini-2.5-pro-think': 'gemini-2.5-pro-think',
  'gemini-2.5-flash-think': 'gemini-2.5-flash-think',
  'gemini-3.0-flash': 'gemini-3.0-flash',
  'gemini-3.0-flash-think': 'gemini-3.0-flash-think',
  'gemini-3.5-flash': 'gemini-3.5-flash',
  'gemini-3.5-flash-think': 'gemini-3.5-flash-think',

  // DeepSeek 系列
  'deepseek-v4-flash': 'deepseek-v4-flash',
  'deepseek-v4-flash-think': 'deepseek-v4-flash-think',
  'deepseek-v4-pro': 'deepseek-v4-pro',
  'deepseek-v4-pro-think': 'deepseek-v4-pro-think',

  // 其他模型
  'grok-4': 'grok-4',
  'glm-5': 'glm-5',
  'glm-5-think': 'glm-5-think',
  'qwen3-max': 'qwen3-max',
  'kimi-k2': 'kimi-k2',
  'llama-3.1-405b': 'llama-3.1-405b',

  // 智能路由
  'sider': 'sider',
};

/**
 * 对外暴露的模型列表（仅 Claude 家族，Anthropic Messages API 兼容）。
 * 对 sider2api 的对齐保留为非 Claude 模型的 Sider 映射，供内部 fallback 和
 * 未来多 API 端点（OpenAI Chat Completions 等）使用。
 */
export const SUPPORTED_MODELS: ModelInfo[] = CLAUDE_MODELS;

/**
 * 模型映射表：Anthropic -> Sider（仅 Claude 家族）。
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
 * 获取完整的 Sider 模型映射（包含非 Claude 厂商模型）。
 * 供内部路由、fallback 和未来多 API 格式端点使用。
 */
export function getFullModelMapping(): Record<string, string> {
  return { ...MODEL_MAP, ...SIDER_FULL_MAPPING };
}

/**
 * 映射模型名称：Anthropic -> Sider。
 *
 * 未显式登记的 Claude 族模型按模型家族保守映射到已探测过的 Sider 模型。
 */
export function mapModelName(anthropicModel: string): string {
  const normalizedModel = anthropicModel.toLowerCase();

  // 先查 Claude 显式映射
  const mapped = MODEL_MAP[normalizedModel];
  if (mapped) {
    return mapped;
  }

  // 再查 Sider 全映射（支持非 Claude 模型）
  const siderMapped = SIDER_FULL_MAPPING[normalizedModel];
  if (siderMapped) {
    return siderMapped;
  }

  // 未知 Claude 族按家族保守映射
  if (normalizedModel.includes('opus')) {
    return normalizedModel.includes('think') ? 'claude-opus-4.6-think' : 'claude-opus-4.6';
  }

  if (normalizedModel.includes('haiku')) {
    return normalizedModel.includes('think') ? 'claude-haiku-4.5-think' : 'claude-haiku-4.5';
  }

  if (normalizedModel.includes('sonnet')) {
    return normalizedModel.includes('think') ? 'claude-sonnet-4.6-think' : 'claude-sonnet-4.6';
  }

  console.warn('Unknown model, using Sider default:', {
    requested: anthropicModel,
    fallback: 'claude-sonnet-4.6',
  });
  return 'claude-sonnet-4.6';
}

export function isModelSupported(modelId: string): boolean {
  return !!getModelById(modelId);
}
