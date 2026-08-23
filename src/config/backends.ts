/**
 * 后端配置管理。
 *
 * Sider 提供 Claude 对话模型；DeepSeek Anthropic 兼容端补齐工具调用等能力。
 */

import { consola } from 'consola';
import { getEnv } from '../utils/env';
import { currentSiderStrategy, resolveSiderStrategy } from '../utils/runtime-strategy';

export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-flash';

export type Backend = 'sider' | 'deepseek';

export interface SiderBackendConfig {
  enabled: boolean;
  apiUrl: string;
  authToken: string;
}

export interface AnthropicBackendConfig {
  enabled: boolean;
  provider: 'deepseek' | 'anthropic-compatible';
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * Sider 投递策略，三档递进。
 *
 * - `conservative`（默认）：静态阈值 + 固定冷却熔断，历史行为，见 utils/sider-availability.ts。
 * - `pro`：自适应限流器主动碰撞上游极限，见 utils/sider-throttle.ts。纯对话优先 Sider，
 *   工具请求仍全部交给 DeepSeek。
 * - `max`：在 `pro` 基础上，**工具调用也先投 Sider**（靠注入文本工具契约实现，
 *   见 utils/textual-tool-use.ts），失败再 fallback DeepSeek。
 *
 * 限流器在 `pro` 与 `max` 下都生效——`max` 不等于无脑硬撞：opus 档配额撞几次
 * 1135 就会自动熔断转 DeepSeek，否则每次都白费一个往返。
 */
export type SiderStrategy = 'conservative' | 'pro' | 'max';

export interface RoutingConfig {
  defaultBackend: Backend;
  autoFallback: boolean;
  preferSiderForSimpleChat: boolean;
  debugMode: boolean;
  siderStrategy: SiderStrategy;
}

export interface BackendConfig {
  sider: SiderBackendConfig;
  deepseek: AnthropicBackendConfig;
  routing: RoutingConfig;
}

const CONFIG_SIGNATURE_KEYS = [
  'SIDER_API_URL',
  'SIDER_AUTH_TOKEN',
  'DEEPSEEK_BASE_URL',
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_MODEL',
  'DEFAULT_BACKEND',
  'AUTO_FALLBACK',
  'PREFER_SIDER_FOR_CHAT',
  'DEBUG_ROUTING',
  'SIDER_STRATEGY',
] as const;

let cachedConfig: BackendConfig | undefined;
let cachedConfigSignature = '';

export function loadBackendConfig(): BackendConfig {
  const signature = buildConfigSignature();
  if (cachedConfig && cachedConfigSignature === signature) {
    return cachedConfig;
  }

  const deepseekBaseUrl = resolveDeepSeekBaseUrl();
  const deepseekApiKey = resolveDeepSeekApiKey();

  const config: BackendConfig = {
    sider: {
      enabled: false,
      apiUrl: getEnv('SIDER_API_URL') || 'https://sider.ai/api/chat/v1/completions',
      authToken: getEnv('SIDER_AUTH_TOKEN') || '',
    },
    deepseek: {
      enabled: false,
      provider: deepseekBaseUrl.includes('deepseek.com') ? 'deepseek' : 'anthropic-compatible',
      baseUrl: deepseekBaseUrl,
      apiKey: deepseekApiKey,
      model: getEnv('DEEPSEEK_MODEL') || DEFAULT_DEEPSEEK_MODEL,
    },
    routing: {
      defaultBackend: parseDefaultBackend(getEnv('DEFAULT_BACKEND')),
      autoFallback: getEnv('AUTO_FALLBACK') !== 'false',
      preferSiderForSimpleChat: getEnv('PREFER_SIDER_FOR_CHAT') !== 'false',
      debugMode: getEnv('DEBUG_ROUTING') === 'true',
      siderStrategy: parseSiderStrategy(getEnv('SIDER_STRATEGY')),
    },
  };

  config.sider.enabled = !!config.sider.authToken;
  config.deepseek.enabled = !!config.deepseek.apiKey;

  // 策略由「运行时覆盖（网页切换）> 环境变量」决定。把字段包成 getter，
  // 让所有读点（路由、契约注入、统计）透明地拿到当前值，不必每处都改。
  const envStrategy = config.routing.siderStrategy;
  Object.defineProperty(config.routing, 'siderStrategy', {
    get: () => currentSiderStrategy(envStrategy),
    enumerable: true,
  });

  validateConfig(config);
  logConfigSummary(config);

  cachedConfig = config;
  cachedConfigSignature = signature;

  return config;
}

function buildConfigSignature(): string {
  return JSON.stringify(CONFIG_SIGNATURE_KEYS.map((key) => [key, getEnv(key)]));
}

function resolveDeepSeekBaseUrl(): string {
  return getEnv('DEEPSEEK_BASE_URL') || 'https://api.deepseek.com/anthropic';
}

function resolveDeepSeekApiKey(): string {
  return getEnv('DEEPSEEK_API_KEY') || '';
}

function parseDefaultBackend(value?: string): Backend {
  if (value === 'deepseek' || value === 'sider') {
    return value;
  }

  if (value === 'anthropic') {
    return 'deepseek';
  }

  return 'sider';
}

function parseSiderStrategy(value?: string): SiderStrategy {
  // `aggressive` 是 `pro` 的旧名，已写进文档，保留别名避免既有部署静默降级。
  if (value === 'pro' || value === 'aggressive') return 'pro';
  if (value === 'max') return 'max';
  return 'conservative';
}

/** 该策略是否启用自适应限流器（`pro` 与 `max` 都启用，只有 `conservative` 用固定冷却）。 */
export function usesAdaptiveThrottle(strategy: SiderStrategy): boolean {
  return strategy !== 'conservative';
}

/** 该策略是否把工具请求也投给 Sider。 */
export function siderHandlesTools(strategy: SiderStrategy): boolean {
  return strategy === 'max';
}

/**
 * 当前生效的策略，供统计/看板这类**不该触发完整配置加载**的路径读取。
 */
export function currentEffectiveSiderStrategy(): SiderStrategy {
  return currentSiderStrategy(parseSiderStrategy(getEnv('SIDER_STRATEGY')));
}

/**
 * 同上，但等 KV 读回来再返回（供 /stats 等展示路径使用）。
 * Node 侧无 KV，行为与同步版一致；保持与 Deno 侧 API 对称。
 */
export async function resolveEffectiveSiderStrategy(): Promise<SiderStrategy> {
  return await resolveSiderStrategy(parseSiderStrategy(getEnv('SIDER_STRATEGY')));
}

function validateConfig(config: BackendConfig): void {
  const errors: string[] = [];

  if (!config.sider.enabled && !config.deepseek.enabled) {
    errors.push('No backend available. Configure SIDER_AUTH_TOKEN or DEEPSEEK_API_KEY.');
  }

  if (config.routing.defaultBackend === 'sider' && !config.sider.enabled) {
    consola.warn('Default backend is Sider, but Sider is not configured.');
    if (config.deepseek.enabled) {
      config.routing.defaultBackend = 'deepseek';
    }
  }

  if (config.routing.defaultBackend === 'deepseek' && !config.deepseek.enabled) {
    consola.warn('Default backend is DeepSeek, but DeepSeek is not configured.');
    if (config.sider.enabled) {
      config.routing.defaultBackend = 'sider';
    }
  }

  if (errors.length > 0) {
    errors.forEach((error) => consola.error(error));
    throw new Error('Invalid backend configuration');
  }
}

function logConfigSummary(config: BackendConfig): void {
  consola.box({
    title: 'Backend Configuration',
    message: `
Sider:
  Status: ${config.sider.enabled ? 'enabled' : 'disabled'}
  ${config.sider.enabled ? `URL: ${config.sider.apiUrl}` : ''}
  ${config.sider.enabled ? `Token: ${maskToken(config.sider.authToken)}` : ''}

DeepSeek:
  Status: ${config.deepseek.enabled ? 'enabled' : 'disabled'}
  ${config.deepseek.enabled ? `Base URL: ${config.deepseek.baseUrl}` : ''}
  ${config.deepseek.enabled ? `Model: ${config.deepseek.model}` : ''}
  ${config.deepseek.enabled ? `API Key: ${maskToken(config.deepseek.apiKey)}` : ''}

Routing:
  Default Backend: ${config.routing.defaultBackend}
  Auto Fallback: ${config.routing.autoFallback ? 'on' : 'off'}
  Prefer Sider for Chat: ${config.routing.preferSiderForSimpleChat ? 'on' : 'off'}
  Debug Mode: ${config.routing.debugMode ? 'on' : 'off'}
  Sider Strategy: ${config.routing.siderStrategy}
    `.trim(),
    style: {
      borderColor: 'cyan',
      borderStyle: 'rounded',
    },
  });
}

function maskToken(token: string): string {
  return token ? '[configured]' : '[missing]';
}

export function getBackendDisplayName(backend: Backend): string {
  return backend === 'sider' ? 'Sider AI' : 'DeepSeek';
}

export function isBackendAvailable(config: BackendConfig, backend: Backend): boolean {
  return backend === 'sider' ? config.sider.enabled : config.deepseek.enabled;
}
