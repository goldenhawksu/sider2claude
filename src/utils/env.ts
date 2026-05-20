/**
 * 环境变量访问适配层。
 *
 * 优先级：
 * 1. 运行时环境变量（shell / CI / Bun）
 * 2. 仓库根目录 `.env`
 * 3. 调用方传入的默认值
 */

import { existsSync, readFileSync } from 'node:fs';

const dotenvCache = new Map<string, string>();
let dotenvLoaded = false;

export function getEnv(key: string, defaultValue = ''): string {
  const runtimeValue = process.env[key];
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

function getDotenvValue(key: string): string | undefined {
  ensureDotenvLoaded();
  return dotenvCache.get(key);
}

function ensureDotenvLoaded(): void {
  if (dotenvLoaded) {
    return;
  }

  dotenvLoaded = true;
  if (!existsSync('.env')) {
    return;
  }

  const text = readFileSync('.env', 'utf8');
  parseDotenv(text).forEach((value, key) => dotenvCache.set(key, value));
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
