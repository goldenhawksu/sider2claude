/**
 * 测试配置文件
 * 支持 Bun 本地、Deno 本地和 Deno Deploy 三种环境
 */

export interface TestConfig {
  apiBaseUrl: string;
  authToken: string;
  environment: 'bun-local' | 'deno-local' | 'deno-deploy';
  description: string;
}

/**
 * 测试环境配置
 * 通过环境变量 TEST_ENV 切换：bun-local | deno-local | deno-deploy
 */
const configs: Record<string, TestConfig> = {
  // Bun 本地开发环境（默认）
  'bun-local': {
    apiBaseUrl: 'http://localhost:4141',
    authToken: 'your-custom-auth-token-here',
    environment: 'bun-local',
    description: 'Bun 本地开发服务器 (端口 4141)',
  },

  // Deno 本地开发环境
  'deno-local': {
    apiBaseUrl: 'http://localhost:4142',
    authToken: 'your-custom-auth-token-here',
    environment: 'deno-local',
    description: 'Deno 本地开发服务器 (端口 4142)',
  },

  // Deno Deploy 生产环境
  'deno-deploy': {
    apiBaseUrl: 'https://your-app.deno.dev',
    authToken: 'sk-this-is-deno-key',
    environment: 'deno-deploy',
    description: 'Deno Deploy 生产环境',
  },
};

/**
 * 获取当前测试配置
 * 默认使用 bun-local，可通过环境变量 TEST_ENV 切换
 */
export function getTestConfig(): TestConfig {
  const env = process.env.TEST_ENV || 'bun-local';

  if (!configs[env]) {
    console.warn(`⚠️  未知的测试环境: ${env}，使用默认配置 (bun-local)`);
    return configs['bun-local'];
  }

  return configs[env];
}

/**
 * 打印当前测试配置
 */
export function printTestConfig(config: TestConfig = getTestConfig()): void {
  console.log('📍 测试配置:');
  console.log(`   环境: ${config.environment}`);
  console.log(`   说明: ${config.description}`);
  console.log(`   API 地址: ${config.apiBaseUrl}`);
  console.log(`   认证 Token: ${config.authToken.substring(0, 20)}...`);
  console.log('============================================================\n');
}

/**
 * 便捷导出
 */
export const config = getTestConfig();
export const API_BASE_URL = config.apiBaseUrl;
export const AUTH_TOKEN = config.authToken;

// 默认导出
export default config;
