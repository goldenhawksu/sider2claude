/**
 * 环境变量访问适配层
 * 统一 Deno 和 Node.js 的环境变量访问方式
 */

export function getEnv(key: string, defaultValue?: string): string {
  // Deno 环境
  if (typeof Deno !== 'undefined' && Deno.env) {
    return Deno.env.get(key) || defaultValue || '';
  }

  // Node.js/Bun 环境（向后兼容）
  if (typeof process !== 'undefined' && process.env) {
    return process.env[key] || defaultValue || '';
  }

  return defaultValue || '';
}

export function requireEnv(key: string): string {
  const value = getEnv(key);
  if (!value) {
    throw new Error(`Required environment variable ${key} is not set`);
  }
  return value;
}

// 导出常用环境变量
export const ENV = {
  PORT: getEnv('PORT', '8000'),
  NODE_ENV: getEnv('NODE_ENV', 'production'),
  SIDER_API_URL: getEnv('SIDER_API_URL', 'https://sider.ai/api/chat/v1/completions'),
  SIDER_AUTH_TOKEN: getEnv('SIDER_AUTH_TOKEN', ''),
  LOG_LEVEL: getEnv('LOG_LEVEL', 'info'),
  REQUEST_TIMEOUT: parseInt(getEnv('REQUEST_TIMEOUT', '30000')),
};
