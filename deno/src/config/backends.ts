/**
 * 后端配置管理
 * 支持 Sider AI 和 Anthropic API 两个后端
 */

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
 * 加载后端配置
 */
export function loadBackendConfig(): BackendConfig {
  const config: BackendConfig = {
    sider: {
      enabled: false,
      apiUrl: Deno.env.get('SIDER_API_URL') || 'https://sider.ai/api/chat/v1/completions',
      authToken: Deno.env.get('SIDER_AUTH_TOKEN') || '',
    },
    anthropic: {
      enabled: false,
      baseUrl: Deno.env.get('ANTHROPIC_BASE_URL') || 'https://api.anthropic.com',
      apiKey: Deno.env.get('ANTHROPIC_API_KEY') || '',
    },
    routing: {
      defaultBackend: (Deno.env.get('DEFAULT_BACKEND') as Backend) || 'sider',
      autoFallback: Deno.env.get('AUTO_FALLBACK') !== 'false',
      preferSiderForSimpleChat: Deno.env.get('PREFER_SIDER_FOR_CHAT') !== 'false',
      debugMode: Deno.env.get('DEBUG_ROUTING') === 'true',
    },
  };

  // 自动检测启用的后端
  if (config.sider.authToken) {
    config.sider.enabled = true;
  }

  if (config.anthropic.apiKey) {
    config.anthropic.enabled = true;
  }

  // 验证配置
  validateConfig(config);

  // 打印配置摘要
  logConfigSummary(config);

  return config;
}

/**
 * 验证配置
 */
function validateConfig(config: BackendConfig): void {
  if (!config.sider.enabled && !config.anthropic.enabled) {
    throw new Error(
      '❌ Configuration Error: At least one backend must be enabled. ' +
      'Please set SIDER_AUTH_TOKEN or ANTHROPIC_API_KEY in environment variables.'
    );
  }

  if (config.routing.defaultBackend === 'sider' && !config.sider.enabled) {
    console.warn('⚠️ Default backend is Sider AI but it is not enabled. Switching to Anthropic API.');
    config.routing.defaultBackend = 'anthropic';
  }

  if (config.routing.defaultBackend === 'anthropic' && !config.anthropic.enabled) {
    console.warn('⚠️ Default backend is Anthropic API but it is not enabled. Switching to Sider AI.');
    config.routing.defaultBackend = 'sider';
  }
}

/**
 * 打印配置摘要
 */
function logConfigSummary(config: BackendConfig): void {
  console.log('╭────────────────🔧 Backend Configuration────────────────╮');
  console.log('│                                                    │');
  console.log('│  📡 Sider AI:                                      │');
  console.log(`│     Status: ${config.sider.enabled ? '✅ Enabled' : '❌ Disabled'}                              │`);
  if (config.sider.enabled) {
    console.log(`│     URL: ${config.sider.apiUrl.substring(0, 48).padEnd(48)}│`);
    console.log('│     Token: ***                                     │');
  }
  console.log('│                                                    │');
  console.log('│  🤖 Anthropic API:                                 │');
  console.log(`│     Status: ${config.anthropic.enabled ? '✅ Enabled' : '❌ Disabled'}                              │`);
  if (config.anthropic.enabled) {
    console.log(`│     Base URL: ${config.anthropic.baseUrl.padEnd(39)}│`);
    console.log(`│     API Key: ${maskToken(config.anthropic.apiKey).padEnd(40)}│`);
  }
  console.log('│                                                    │');
  console.log('│  🎯 Routing:                                       │');
  console.log(`│     Default Backend: ${config.routing.defaultBackend.padEnd(33)}│`);
  console.log(`│     Auto Fallback: ${config.routing.autoFallback ? 'ON' : 'OFF'}                              │`);
  console.log(`│     Prefer Sider for Chat: ${config.routing.preferSiderForSimpleChat ? 'ON' : 'OFF'}                      │`);
  console.log(`│     Debug Mode: ${config.routing.debugMode ? 'ON' : 'OFF'}                                │`);
  console.log('│                                                    │');
  console.log('╰────────────────────────────────────────────────────╯');
}

/**
 * 遮罩 Token（仅显示前后几位）
 */
function maskToken(token: string): string {
  if (!token) return '';
  if (token.length <= 10) return '***';
  return `${token.substring(0, 10)}...${token.substring(token.length - 4)}`;
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
