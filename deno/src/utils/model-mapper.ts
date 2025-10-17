/**
 * 动态模型映射管理器
 * 自动从 API 端点获取模型列表并建立智能映射
 */

import { consola } // from 'consola';

interface ModelInfo {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

interface ModelsListResponse {
  data: ModelInfo[];
  object: string;
}

/**
 * 从模型名称中提取日期 (YYYYMMDD 格式)
 */
function extractDate(modelName: string): number {
  const match = modelName.match(/(\d{8})/);
  return match ? parseInt(match[1]) : 0;
}

/**
 * 模型名称相似度计算
 * 使用特征匹配、字符串相似度和日期偏好
 */
function calculateSimilarity(source: string, target: string): number {
  // 标准化模型名称
  const normalize = (name: string) => name.toLowerCase().replace(/[-_.]/g, '');
  const normalizedSource = normalize(source);
  const normalizedTarget = normalize(target);

  // 1. 精确匹配
  if (normalizedSource === normalizedTarget) {
    return 1.0;
  }

  // 2. 包含关系 (目标包含源)
  if (normalizedTarget.includes(normalizedSource)) {
    return 0.9;
  }

  // 3. 提取关键特征
  const extractFeatures = (name: string) => {
    const features: string[] = [];

    // Claude 版本号
    if (name.match(/claude\s*4\.?5/i)) features.push('claude45');
    else if (name.match(/claude\s*3\.?7/i)) features.push('claude37');
    else if (name.match(/claude\s*3\.?5/i)) features.push('claude35');
    else if (name.match(/claude\s*3/i)) features.push('claude3');
    else if (name.match(/claude\s*2/i)) features.push('claude2');

    // 模型类型
    if (name.match(/sonnet/i)) features.push('sonnet');
    if (name.match(/opus/i)) features.push('opus');
    if (name.match(/haiku/i)) features.push('haiku');

    // 特殊标记
    if (name.match(/thinking?/i)) features.push('thinking');

    return features;
  };

  const sourceFeatures = extractFeatures(source);
  const targetFeatures = extractFeatures(target);

  // 4. 特征匹配度
  const matchedFeatures = sourceFeatures.filter(f => targetFeatures.includes(f));
  if (sourceFeatures.length === 0) return 0;

  const featureScore = matchedFeatures.length / sourceFeatures.length;

  // 5. 字符串相似度 (简化版 Levenshtein)
  const maxLen = Math.max(normalizedSource.length, normalizedTarget.length);
  const commonChars = [...normalizedSource].filter(c => normalizedTarget.includes(c)).length;
  const charScore = commonChars / maxLen;

  // 6. 综合评分 (不包含日期,日期在 mapModel 中单独处理)
  return featureScore * 0.7 + charScore * 0.3;
}

export class ModelMapper {
  private baseUrl: string;
  private apiKey: string;
  private mappingCache: Map<string, string> = new Map();
  private availableModels: Set<string> = new Set();
  private initialized: boolean = false;
  private initPromise: Promise<void> | null = null;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  /**
   * 初始化映射器 - 获取可用模型列表
   */
  async initialize(): Promise<void> {
    // 避免重复初始化
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._initialize();
    return this.initPromise;
  }

  private async _initialize(): Promise<void> {
    try {
      console.info('🔄 Initializing model mapper for:', this.baseUrl);

      // 尝试获取模型列表
      const models = await this.fetchAvailableModels();

      if (models.length === 0) {
        console.warn('⚠️  No models found, using fallback mapping');
        this.initializeFallbackMapping();
      } else {
        console.success(`✅ Found ${models.length} available models`);
        models.forEach(model => this.availableModels.add(model.id));

        // 打印 Claude 模型
        const claudeModels = models.filter(m => m.id.toLowerCase().includes('claude'));
        if (claudeModels.length > 0) {
          console.info('📋 Claude models:', claudeModels.map(m => m.id).slice(0, 10));
        }
      }

      this.initialized = true;
    } catch (error) {
      console.error('❌ Failed to initialize model mapper:', error);
      // 降级到静态映射
      this.initializeFallbackMapping();
      this.initialized = true;
    }
  }

  /**
   * 从 API 端点获取可用模型列表
   */
  private async fetchAvailableModels(): Promise<ModelInfo[]> {
    const endpoints = ['/v1/models', '/models'];

    for (const endpoint of endpoints) {
      try {
        const response = await fetch(`${this.baseUrl}${endpoint}`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'x-api-key': this.apiKey,
          },
        });

        if (response.ok) {
          const data: ModelsListResponse = await response.json();
          return data.data || [];
        }
      } catch (error) {
        // 继续尝试下一个端点
        continue;
      }
    }

    return [];
  }

  /**
   * 初始化降级映射 (当无法获取模型列表时)
   */
  private initializeFallbackMapping(): void {
    // 通用的 Claude 模型映射
    const fallbackMappings: Record<string, string[]> = {
      'claude-4.5-sonnet': ['claude-sonnet-4-5-20250929', 'claude-sonnet-4.5', 'claude-4-5-sonnet'],
      'claude-3.5-sonnet': ['claude-3-5-sonnet-20241022', 'claude-3-5-sonnet-latest'],
      'claude-3-opus': ['claude-3-opus-20240229'],
      'claude-3-haiku': ['claude-3-haiku-20240307'],
    };

    Object.entries(fallbackMappings).forEach(([standard, candidates]) => {
      candidates.forEach(candidate => this.availableModels.add(candidate));
    });

    console.info('📋 Initialized fallback model mapping');
  }

  /**
   * 映射模型名称 - 自动找到最匹配的可用模型
   */
  async mapModel(requestedModel: string): Promise<string> {
    // 确保已初始化
    await this.initialize();

    // 1. 检查缓存
    if (this.mappingCache.has(requestedModel)) {
      return this.mappingCache.get(requestedModel)!;
    }

    // 2. 检查是否直接可用
    if (this.availableModels.has(requestedModel)) {
      this.mappingCache.set(requestedModel, requestedModel);
      return requestedModel;
    }

    // 3. 智能匹配 - 收集所有候选模型及其分数
    interface Candidate {
      model: string;
      score: number;
      date: number;
    }

    const candidates: Candidate[] = [];

    for (const availableModel of this.availableModels) {
      const score = calculateSimilarity(requestedModel, availableModel);

      if (score > 0.6) { // 只考虑相似度 > 0.6 的模型
        candidates.push({
          model: availableModel,
          score,
          date: extractDate(availableModel),
        });
      }
    }

    // 4. 没有找到匹配
    if (candidates.length === 0) {
      console.warn('⚠️  No suitable model mapping found:', {
        requested: requestedModel,
        available: Array.from(this.availableModels).filter(m => m.includes('claude')).slice(0, 5),
      });
      return requestedModel;
    }

    // 5. 排序: 先按相似度降序, 相似度相同时按日期降序
    candidates.sort((a, b) => {
      // 相似度差异超过 0.01,则按相似度排序
      if (Math.abs(a.score - b.score) > 0.01) {
        return b.score - a.score;
      }
      // 相似度接近,则优先选择日期更新的
      return b.date - a.date;
    });

    const bestMatch = candidates[0].model;
    const bestScore = candidates[0].score;

    console.info('🔄 Model mapped:', {
      from: requestedModel,
      to: bestMatch,
      similarity: (bestScore * 100).toFixed(1) + '%',
      date: candidates[0].date || 'N/A',
    });

    this.mappingCache.set(requestedModel, bestMatch);
    return bestMatch;
  }

  /**
   * 获取所有可用的 Claude 模型
   */
  getAvailableClaudeModels(): string[] {
    return Array.from(this.availableModels)
      .filter(m => m.toLowerCase().includes('claude'))
      .sort();
  }

  /**
   * 清除映射缓存 (用于热重载配置)
   */
  clearCache(): void {
    this.mappingCache.clear();
    this.availableModels.clear();
    this.initialized = false;
    this.initPromise = null;
    console.info('🗑️  Model mapper cache cleared');
  }

  /**
   * 获取映射统计信息
   */
  getStats() {
    return {
      initialized: this.initialized,
      cachedMappings: this.mappingCache.size,
      availableModels: this.availableModels.size,
      claudeModels: this.getAvailableClaudeModels().length,
    };
  }
}
