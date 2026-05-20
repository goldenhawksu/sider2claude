/**
 * 后端配置管理。
 *
 * Sider 提供 Claude 对话模型；DeepSeek Anthropic 兼容端补齐工具调用等能力。
 */

import { consola } from 'consola';
import { getEnv } from '../utils/env';

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
