/**
 * 模型配置。
 *
 * 这里维护的是对外暴露给 Claude Code 的 Anthropic 模型名，以及这些模型
 * 在 Sider 服务端的真实模型名。模型清单严格同步
 * 参考仓库 goldenhawksu/sider2api 的 deno_pro.ts MODEL_MAPPING。
 *
 * 本文件在 Deno 与 Node/Bun 两套运行时下内容必须完全一致：
 * `src/config/models.ts` 与 `deno/src/config/models.ts`。
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

// ── Claude 家族（Anthropic Messages API 对外） ──
// 只有对外名与 Sider 名不一致时才写第二个参数，其余同名。
const CLAUDE_MODELS: ModelInfo[] = [
  // Opus 系列
  model('claude-4.1-opus'),
  model('claude-4.1-opus-think'),
  model('claude-4-opus'),
  model('claude-4-opus-think'),
  model('claude-3-opus'),
  model('claude-opus-4.8'),
  model('claude-opus-4.8-think'),
  model('claude-opus-5'),
  model('claude-opus-5-think'),
  model('claude-opus-5.5'),
  model('claude-fable-5.1'),
  model('claude-fable-5.1-think'),

  // Sonnet 系列
  model('claude-3.5-sonnet'),
  model('claude-3.7-sonnet'),
  model('claude-3.7-sonnet-think'),
  model('claude-4-sonnet'),
  model('claude-4-sonnet-think'),
  model('claude-4.5-sonnet'),
  model('claude-4.5-sonnet-think'),
  model('claude-sonnet-4.6'),
  model('claude-sonnet-4.6-think'),
  model('claude-sonnet-5'),
  model('claude-sonnet-5-think'),
  model('claude-sonnet-5.5'),

  // Haiku 系列
  model('claude-3-haiku'),
  model('claude-3.5-haiku'),
  model('claude-haiku-4.5'),
  model('claude-haiku-4.5-think'),
];

// ── Sider 支持的其余上游模型（参考 sider2api deno_pro.ts MODEL_MAPPING） ──
// 这些模型对外名与 Sider 名一致，无需改名；与 CLAUDE_MODELS 重名的以上表为准。
const SIDER_UPSTREAM_MODELS: string[] = [
  // GPT 系列
  'gpt-4.1',
  'gpt-5',
  'gpt-5-think',
  'gpt-5-mini',
  'gpt-5.1',
  'gpt-5.1-think',
  'gpt-5.4-mini',
  'gpt-5.4-think',
  'gpt-5.5',
  'gpt-5.5-think',
  'gpt-5.6-sol',
  'gpt-5.6-sol-think',
  'gpt-5.6-terra',
  'gpt-5.6-terra-think',
  'gpt-5.6-luna',
  'gpt-5.6-luna-think',
  'gpt-6-astra',
  'gpt-6-sol-think',
  'gpt-6-luna-think',
  'gpt-4.1-mini',
  'gpt-6-luna',
  'gpt-6.1-sol',
  'gpt-5.2',
  'gpt-5.2-think',
  'o4-mini',
  'o3',
  'o1',
  'o3-mini',
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-4.5',
  'o1-mini',
  'gpt-3.5',
  'gpt-4',

  // Claude 系列（对齐 sider2api 的命名风格）
  'claude-opus-4.8',
  'claude-opus-4.8-think',
  'claude-opus-5',
  'claude-opus-5-think',
  'claude-fable-5.1',
  'claude-fable-5.1-think',
  'claude-4.5-sonnet',
  'claude-4.5-sonnet-think',
  'claude-sonnet-4.6',
  'claude-sonnet-4.6-think',
  'claude-sonnet-5',
  'claude-sonnet-5-think',
  'claude-haiku-4.5',
  'claude-haiku-4.5-think',
  'claude-3.5-haiku',
  'claude-opus-5.5',
  'claude-sonnet-5.5',
  'claude-3.7-sonnet',
  'claude-4-sonnet',
  'claude-3.7-sonnet-think',
  'claude-4-sonnet-think',
  'claude-4.1-opus',
  'claude-4.1-opus-think',
  'claude-4-opus',
  'claude-4-opus-think',
  'claude-3.5-sonnet',
  'claude-3-haiku',
  'claude-3-opus',

  // Gemini 系列
  'gemini-2.5-pro',
  'gemini-2.5-pro-think',
  'gemini-2.5-flash-think',
  'gemini-3.0-flash',
  'gemini-3.0-flash-think',
  'gemini-3.5-flash',
  'gemini-3.5-flash-think',
  'gemini-3.6-flash',
  'gemini-3.6-flash-think',
  'gemini-3.8-flash',
  'gemini-3.8-flash-think',
  'gemini-3.5-flash-lite',
  'gemini-3.5-flash-lite-think',
  'gemini-3.0-pro',
  'gemini-3.1-pro',
  'gemini-3.0-pro-think',
  'gemini-3.1-pro-think',
  'gemini-2.0-flash',
  'gemini-2.0-pro',
  'gemini-1.5-pro',
  'gemini-1.5-flash',

  // DeepSeek 系列
  'deepseek-v4-flash',
  'deepseek-v4-flash-think',
  'deepseek-v4-pro',
  'deepseek-v4-pro-think',
  'deepseek-v3.1',
  'deepseek-v3.1-think',
  'deepseek-reasoner',
  'deepseek-v3.2',
  'deepseek-v3.2-think',
  'deepseek-r1-distill-llama-70b',

  // 其他模型
  'grok-4',
  'grok-4.6',
  'glm-5',
  'glm-5-think',
  'qwen3.8-max',
  'kimi-k3',
  'llama-3.1-405b',
  'glm-5.3-flash',
  'qwen3.8-max-think',
  'llama-3.3-70b',
  'llama-3',

  // 智能路由
  'sider',
];

/**
 * 对外暴露参考映射中的全部上游模型。
 * Claude 家族在前且优先，重名的上游模型条目会被跳过。
 */
function buildAllUpstreamModels(): ModelInfo[] {
  const models = [...CLAUDE_MODELS];
  const seen = new Set(models.map((modelInfo) => modelInfo.id.toLowerCase()));

  for (const id of SIDER_UPSTREAM_MODELS) {
    const normalized = id.toLowerCase();
    if (seen.has(normalized)) {
      continue;
    }

    models.push(model(id));
    seen.add(normalized);
  }

  return models;
}

export const SUPPORTED_MODELS: ModelInfo[] = buildAllUpstreamModels();

/**
 * 模型映射表：对外模型名 -> Sider 模型名。
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
 * 获取完整的 Sider 模型映射。
 * SUPPORTED_MODELS 已经包含全部上游模型，MODEL_MAP 即完整映射。
 */
export function getFullModelMapping(): Record<string, string> {
  return { ...MODEL_MAP };
}

/**
 * 映射模型名称：对外模型名 -> Sider 模型名。
 *
 * 未显式登记的 Claude 族模型按模型家族保守映射到已探测过的 Sider 模型。
 */
export function mapModelName(anthropicModel: string): string {
  const normalizedModel = anthropicModel.toLowerCase();

  const mapped = MODEL_MAP[normalizedModel];
  if (mapped) {
    return mapped;
  }

  // 未知 Claude 族按家族保守映射
  if (normalizedModel.includes('opus')) {
    return normalizedModel.includes('think') ? 'claude-opus-4.8-think' : 'claude-opus-4.8';
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
