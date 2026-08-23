/**
 * 环境变量访问适配层。
 *
 * 优先级：
 * 1. 运行时环境变量（Deno Deploy / shell / CI）
 * 2. 仓库根目录 `.env`（本地开发与探测）
 * 3. 调用方传入的默认值
 *
 * 这里不打印任何变量值，避免泄露 token。
 */

const dotenvCache = new Map<string, string>();
let dotenvLoaded = false;

export function getEnv(key: string, defaultValue = ''): string {
  const runtimeValue = getRuntimeEnv(key);
  if (runtimeValue !== undefined && runtimeValue !== '') {
    return runtimeValue;
  }

  const fileValue = getDotenvValue(key);
  if (fileValue !== undefined && fileValue !== '') {
    return fileValue;
  }

  return defaultValue;
}

export function getOptionalEnv(key: string): string | undefined {
  const value = getEnv(key);
  return value === '' ? undefined : value;
}

export function requireEnv(key: string): string {
  const value = getEnv(key);
  if (!value) {
    throw new Error(`Required environment variable ${key} is not set`);
  }
  return value;
}

function getRuntimeEnv(key: string): string | undefined {
  try {
    return Deno.env.get(key) || undefined;
  } catch {
    return undefined;
  }
}

function getDotenvValue(key: string): string | undefined {
  ensureDotenvLoaded();
  return dotenvCache.get(key);
}

function ensureDotenvLoaded(): void {
  if (dotenvLoaded) {
    return;
  }

  dotenvLoaded = true;

  // 按优先级找第一个存在的 dotenv：`deno/.env` 是本运行时的配置源，
  // 根 `.env` 仅作旧布局的兼容回退。找到一个就停——两份都读会让"改了哪个生效"
  // 变成猜谜，而这正是此前 Z.AI 切换只改 deno/.env 却不生效的坑。
  for (const path of ['deno/.env', '.env']) {
    try {
      const text = Deno.readTextFileSync(path);
      parseDotenv(text).forEach((value, key) => dotenvCache.set(key, value));
      return;
    } catch {
      // 该路径不存在就试下一个
    }
  }
  // Deno Deploy、CI 或无 --allow-read 时一个都没有很正常，安静降级即可。
}

function parseDotenv(text: string): Map<string, string> {
  const values = new Map<string, string>();

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
    const value = normalizeDotenvValue(line.slice(separator + 1).trim());
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

export const ENV = {
  PORT: getEnv('PORT', '8000'),
  NODE_ENV: getEnv('NODE_ENV', 'production'),
  SIDER_API_URL: getEnv('SIDER_API_URL', 'https://sider.ai/api/chat/v1/completions'),
  SIDER_AUTH_TOKEN: getEnv('SIDER_AUTH_TOKEN'),
  LOG_LEVEL: getEnv('LOG_LEVEL', 'info'),
  REQUEST_TIMEOUT: parseInt(getEnv('REQUEST_TIMEOUT', '30000'), 10),
};
