/**
 * 后端配置管理。
 *
 * 目标：
 * - Claude/Anthropic 模型对外仍完整暴露给 Claude Code。
 * - 普通对话优先由 Sider 提供。
 * - Sider 无法稳定提供的 Anthropic 能力（例如工具调用）由 DeepSeek 兼容端补齐。
 */

import { getEnv } from '../utils/env.ts';

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

export interface RoutingConfig {
  defaultBackend: Backend;
  autoFallback: boolean;
  preferSiderForSimpleChat: boolean;
  debugMode: boolean;
}

export interface BackendConfig {
  sider: SiderBackendConfig;
  deepseek: AnthropicBackendConfig;
  routing: RoutingConfig;
}

/**
 * 加载后端配置。
 *
 * 新配置项使用 DEEPSEEK_*；ANTHROPIC_* 保留为旧部署的兼容别名。
 */
export function loadBackendConfig(): BackendConfig {
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
    },
  };

  config.sider.enabled = !!config.sider.authToken;
  config.deepseek.enabled = !!config.deepseek.apiKey;

  validateConfig(config);
  logConfigSummary(config);

  return config;
}

function resolveDeepSeekBaseUrl(): string {
  const explicitDeepSeekUrl = getEnv('DEEPSEEK_BASE_URL');
  if (explicitDeepSeekUrl) {
    return explicitDeepSeekUrl;
  }

  const legacyAnthropicUrl = getEnv('ANTHROPIC_BASE_URL');
  if (legacyAnthropicUrl?.includes('deepseek.com')) {
    return legacyAnthropicUrl;
  }

  return 'https://api.deepseek.com/anthropic';
}

function resolveDeepSeekApiKey(): string {
  const explicitDeepSeekKey = getEnv('DEEPSEEK_API_KEY');
  if (explicitDeepSeekKey) {
    return explicitDeepSeekKey;
  }

  const legacyAnthropicKey = getEnv('ANTHROPIC_API_KEY');
  if (!legacyAnthropicKey) {
    return '';
  }

  const explicitDeepSeekUrl = getEnv('DEEPSEEK_BASE_URL');
  const legacyAnthropicUrl = getEnv('ANTHROPIC_BASE_URL');
  if (explicitDeepSeekUrl || !legacyAnthropicUrl || legacyAnthropicUrl.includes('deepseek.com')) {
    return legacyAnthropicKey;
  }

  return '';
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
