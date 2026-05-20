/**
 * 测试配置文件
 * 支持 Bun 本地、Deno 本地和远端部署三种环境。
 *
 * 优先级：
 * 1. 运行时环境变量
 * 2. 仓库根目录 .env
 * 3. 测试默认值
 */

import { existsSync, readFileSync } from 'node:fs';

export interface TestConfig {
  apiBaseUrl: string;
  authToken: string;
  environment: 'bun-local' | 'deno-local' | 'deno-deploy';
  description: string;
}

const dotenvValues = loadDotenv();

function readConfigValue(key: string, defaultValue = ''): string {
  const runtimeValue = process.env[key];
  if (runtimeValue !== undefined && runtimeValue !== '') {
    return runtimeValue;
  }

  const fileValue = dotenvValues.get(key);
  if (fileValue !== undefined && fileValue !== '') {
    return fileValue;
  }

  return defaultValue;
}

function loadDotenv(): Map<string, string> {
  const values = new Map<string, string>();
  const envPath = new URL('../.env', import.meta.url);

  if (!existsSync(envPath)) {
    return values;
  }

  const text = readFileSync(envPath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const separator = line.indexOf('=');
    if (separator <= 0) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    const value = normalizeDotenvValue(rawValue);
    values.set(key, value);
  }

  return values;
}

function normalizeDotenvValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  const commentIndex = value.search(/\s+#/);
  return commentIndex >= 0 ? value.slice(0, commentIndex).trim() : value;
}

function resolveAuthToken(): string {
  return readConfigValue('TEST_AUTH_TOKEN') || readConfigValue('AUTH_TOKEN') || 'dummy';
}

function maskToken(token: string): string {
  if (!token) return '(empty)';
  if (token.length <= 10) return '***';
  return `${token.slice(0, 8)}...${token.slice(-4)}`;
}

/**
 * 测试环境配置
 * 通过环境变量 TEST_ENV 切换：bun-local | deno-local | deno-deploy
 */
const configs: Record<string, TestConfig> = {
  'bun-local': {
    apiBaseUrl: readConfigValue('TEST_API_BASE_URL') || readConfigValue('BUN_TEST_API_BASE_URL') ||
      'http://localhost:4141',
    authToken: resolveAuthToken(),
    environment: 'bun-local',
    description: 'Bun 本地开发服务器 (端口 4141)',
  },

  'deno-local': {
    apiBaseUrl: readConfigValue('TEST_API_BASE_URL') || readConfigValue('DENO_TEST_API_BASE_URL') ||
      'http://localhost:8000',
    authToken: resolveAuthToken(),
    environment: 'deno-local',
    description: 'Deno 本地开发服务器 (默认端口 8000，可用 PORT/TEST_API_BASE_URL 覆盖)',
  },

  'deno-deploy': {
    apiBaseUrl: readConfigValue('TEST_API_BASE_URL') || readConfigValue('DENO_DEPLOY_URL'),
    authToken: resolveAuthToken(),
    environment: 'deno-deploy',
    description: '远端 Deno Deploy/兼容部署环境',
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
  console.log(`   认证 Token: ${maskToken(config.authToken)}`);
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
