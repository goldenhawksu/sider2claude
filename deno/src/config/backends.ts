/**
 * 后端配置管理。
 *
 * 目标：
 * - Claude/Anthropic 模型对外仍完整暴露给 Claude Code。
 * - 普通对话优先由 Sider 提供。
 * - Sider 无法稳定提供的 Anthropic 能力（例如工具调用）由 DeepSeek 兼容端补齐。
 */

import { getEnv } from '../utils/env.ts';
import { currentSiderStrategy } from '../utils/runtime-strategy.ts';

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

/**
 * 加载后端配置。
 *
 * 工具能力兜底统一走 `DEEPSEEK_*` 一套配置。`DEEPSEEK_BASE_URL` 可以指向任意
 * Anthropic 兼容端——例如要用 Z.AI 的 GLM-5.3，只需把 `DEEPSEEK_BASE_URL` 改成
 * Z.AI 的 Anthropic 兼容入口、`DEEPSEEK_API_KEY` 改成 Z.AI 的 key、
 * `DEEPSEEK_MODEL` 改成 GLM-5.3 的模型名，其余不用动。
 */
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
  // 环境变量仍是 getter 的兜底：没有任何运行时覆盖时，行为与直接读环境变量一致。
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
 *
 * 与路由用的 getter（在 config.routing.siderStrategy 上）同一来源，
 * 但这里不经过 `loadBackendConfig()`——那会在无 token 的环境（如测试）里抛错，
 * 而统计快照永远不应该因为后端没配好而崩掉。
 */
export function currentEffectiveSiderStrategy(): SiderStrategy {
  return currentSiderStrategy(parseSiderStrategy(getEnv('SIDER_STRATEGY')));
}

function validateConfig(config: BackendConfig): void {
  if (!config.sider.enabled && !config.deepseek.enabled) {
    throw new Error(
      'Configuration error: set SIDER_AUTH_TOKEN for Sider chat or DEEPSEEK_API_KEY for capability fallback.',
    );
  }

  if (config.routing.defaultBackend === 'sider' && !config.sider.enabled) {
    console.warn('Default backend is Sider, but Sider is not configured. Switching to DeepSeek.');
    config.routing.defaultBackend = 'deepseek';
  }

  if (config.routing.defaultBackend === 'deepseek' && !config.deepseek.enabled) {
    console.warn(
      'Default backend is DeepSeek, but DeepSeek is not configured. Switching to Sider.',
    );
    config.routing.defaultBackend = 'sider';
  }
}

function logConfigSummary(config: BackendConfig): void {
  console.log('Backend configuration:');
  console.log(`  Sider: ${config.sider.enabled ? 'enabled' : 'disabled'}`);
  if (config.sider.enabled) {
    console.log(`    URL: ${config.sider.apiUrl}`);
    console.log(`    Token: ${maskToken(config.sider.authToken)}`);
  }

  console.log(`  DeepSeek: ${config.deepseek.enabled ? 'enabled' : 'disabled'}`);
  if (config.deepseek.enabled) {
    console.log(`    Base URL: ${config.deepseek.baseUrl}`);
    console.log(`    Model: ${config.deepseek.model}`);
    console.log(`    API key: ${maskToken(config.deepseek.apiKey)}`);
  }

  console.log(`  Default backend: ${config.routing.defaultBackend}`);
  console.log(`  Auto fallback: ${config.routing.autoFallback ? 'on' : 'off'}`);
  console.log(`  Prefer Sider for chat: ${config.routing.preferSiderForSimpleChat ? 'on' : 'off'}`);
  console.log(`  Debug routing: ${config.routing.debugMode ? 'on' : 'off'}`);
  console.log(`  Sider strategy: ${config.routing.siderStrategy}`);
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
