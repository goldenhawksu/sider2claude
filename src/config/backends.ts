/**
 * 后端配置管理
 * 支持 Sider AI 和 Anthropic API 双后端
 */

import { consola } from 'consola';

export type Backend = 'sider' | 'anthropic';

export interface SiderBackendConfig {
  enabled: boolean;
  apiUrl: string;
  authToken: string;
}

export interface AnthropicBackendConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
}

export interface RoutingConfig {
  defaultBackend: Backend;
  autoFallback: boolean;
  preferSiderForSimpleChat: boolean;
  debugMode: boolean;
}

export interface BackendConfig {
  sider: SiderBackendConfig;
  anthropic: AnthropicBackendConfig;
  routing: RoutingConfig;
}

/**
 * 从环境变量加载后端配置
 */
export function loadBackendConfig(): BackendConfig {
  const config: BackendConfig = {
    sider: {
      enabled: false,
      apiUrl: process.env.SIDER_API_URL || 'https://sider.ai/api/chat/v1/completions',
      authToken: process.env.SIDER_AUTH_TOKEN || '',
    },
    anthropic: {
      enabled: false,
      baseUrl: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
      apiKey: process.env.ANTHROPIC_API_KEY || '',
    },
    routing: {
      defaultBackend: (process.env.DEFAULT_BACKEND as Backend) || 'sider',
      autoFallback: process.env.AUTO_FALLBACK !== 'false',
      preferSiderForSimpleChat: process.env.PREFER_SIDER_FOR_CHAT !== 'false',
      debugMode: process.env.DEBUG_ROUTING === 'true',
    },
  };

  // 检测 Sider AI 是否可用
  if (config.sider.authToken) {
    config.sider.enabled = true;
  }

  // 检测 Anthropic API 是否可用
  if (config.anthropic.apiKey) {
    config.anthropic.enabled = true;
  }

  // 验证配置
  validateConfig(config);

  // 打印配置信息（脱敏）
  logConfigSummary(config);

  return config;
}

/**
 * 验证配置
 */
function validateConfig(config: BackendConfig): void {
  const errors: string[] = [];

  // 至少需要一个后端可用
  if (!config.sider.enabled && !config.anthropic.enabled) {
    errors.push('❌ No backend available. Please configure SIDER_AUTH_TOKEN or ANTHROPIC_API_KEY');
  }

  // 如果默认后端不可用，给出警告
  if (config.routing.defaultBackend === 'sider' && !config.sider.enabled) {
    consola.warn('⚠️ Default backend is "sider" but Sider AI is not configured');
    if (config.anthropic.enabled) {
      consola.info('→ Will use Anthropic API as fallback');
      config.routing.defaultBackend = 'anthropic';
    }
  }

  if (config.routing.defaultBackend === 'anthropic' && !config.anthropic.enabled) {
    consola.warn('⚠️ Default backend is "anthropic" but Anthropic API is not configured');
    if (config.sider.enabled) {
      consola.info('→ Will use Sider AI as fallback');
      config.routing.defaultBackend = 'sider';
    }
  }

  if (errors.length > 0) {
    consola.error('Configuration errors:');
    errors.forEach(error => consola.error(error));
    throw new Error('Invalid backend configuration');
  }
}

/**
 * 打印配置摘要（脱敏）
 */
function logConfigSummary(config: BackendConfig): void {
  consola.box({
    title: '🔧 Backend Configuration',
    message: `
📡 Sider AI:
   Status: ${config.sider.enabled ? '✅ Enabled' : '❌ Disabled'}
   ${config.sider.enabled ? `URL: ${config.sider.apiUrl}` : ''}
   ${config.sider.enabled ? `Token: ${maskToken(config.sider.authToken)}` : ''}

🤖 Anthropic API:
   Status: ${config.anthropic.enabled ? '✅ Enabled' : '❌ Disabled'}
   ${config.anthropic.enabled ? `Base URL: ${config.anthropic.baseUrl}` : ''}
   ${config.anthropic.enabled ? `API Key: ${maskToken(config.anthropic.apiKey)}` : ''}

🎯 Routing:
   Default Backend: ${config.routing.defaultBackend}
   Auto Fallback: ${config.routing.autoFallback ? 'ON' : 'OFF'}
   Prefer Sider for Chat: ${config.routing.preferSiderForSimpleChat ? 'ON' : 'OFF'}
   Debug Mode: ${config.routing.debugMode ? 'ON' : 'OFF'}
    `.trim(),
    style: {
      borderColor: 'cyan',
      borderStyle: 'rounded',
    },
  });
}

/**
 * 脱敏处理 Token
 */
function maskToken(token: string): string {
  if (!token || token.length < 20) return '***';
  return token.substring(0, 10) + '...' + token.substring(token.length - 4);
}

/**
 * 获取后端显示名称
 */
export function getBackendDisplayName(backend: Backend): string {
  return backend === 'sider' ? 'Sider AI' : 'Anthropic API';
}

/**
 * 检查后端是否可用
 */
export function isBackendAvailable(config: BackendConfig, backend: Backend): boolean {
  return backend === 'sider' ? config.sider.enabled : config.anthropic.enabled;
}
