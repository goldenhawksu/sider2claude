/**
 * 认证中间件
 *
 * 三类凭证：
 * - `AUTH_TOKEN`：调用 /v1/* 的客户端凭证。
 * - `ADMIN_TOKEN`：修改运行时策略等管理操作；未配置时回退 `AUTH_TOKEN`。
 * - `STATS_TOKEN`：只读看板；客户端与管理凭证同样可读看板。
 *
 * 默认失败关闭：没有配置 `AUTH_TOKEN` 时拒绝所有请求（503），只有显式设置
 * `ALLOW_OPEN_AUTH=true` 才退回旧的「任意 ≥10 字符 token 均放行」行为，
 * 避免部署时漏配一个变量就把实例与上游额度公开到公网。
 */

import type { Context, Next } from 'hono';
import { getEnv } from '../utils/env';

// 认证错误类型
export class AuthError extends Error {
  constructor(
    message: string,
    public statusCode: number = 401,
    public code: string = 'AUTH_ERROR',
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

// 提取的认证信息
export interface AuthInfo {
  token: string;
  type: 'bearer' | 'x-api-key';
}

/**
 * 从 Authorization header 提取 Bearer token
 */
export function extractBearerToken(authHeader: string | undefined): string {
  if (!authHeader) {
    throw new AuthError('Missing Authorization header', 401, 'MISSING_AUTH');
  }

  // 验证格式: "Bearer <token>" 或 "bearer <token>"
  const match = authHeader.match(/^bearer\s+(.+)$/i);
  if (!match) {
    throw new AuthError(
      'Invalid Authorization header format. Expected: Bearer <token>',
      401,
      'INVALID_AUTH_FORMAT',
    );
  }

  const token = match[1]?.trim();
  if (!token) {
    throw new AuthError('Empty token in Authorization header', 401, 'EMPTY_TOKEN');
  }

  return token;
}

/**
 * 提取认证 Token (支持多种格式)
 * 优先级: x-api-key > Authorization (Bearer)
 */
export function extractAuthToken(c: Context): { token: string; type: 'bearer' | 'x-api-key' } {
  // 1. 检查 x-api-key header (Anthropic 官方格式)
  const xApiKey = c.req.header('x-api-key');
  if (xApiKey?.trim()) {
    return {
      token: xApiKey.trim(),
      type: 'x-api-key',
    };
  }

  // 2. 检查 Authorization header (Bearer token)
  const authHeader = c.req.header('authorization');
  if (authHeader) {
    const token = extractBearerToken(authHeader);
    return {
      token,
      type: 'bearer',
    };
  }

  // 3. 都没有，抛出错误
  throw new AuthError(
    'Missing authentication. Provide either "Authorization: Bearer <token>" or "x-api-key: <token>" header',
    401,
    'MISSING_AUTH',
  );
}

/** 常量时间比较，避免按字节提前返回带来的计时侧信道。 */
export function timingSafeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let index = 0; index < length; index++) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return diff === 0;
}

/** 显式开启的开放模式：未配置 AUTH_TOKEN 时仍按旧规则放行。仅用于本地开发与测试。 */
export function isOpenAuthAllowed(): boolean {
  return getEnv('ALLOW_OPEN_AUTH') === 'true';
}

/** 管理凭证：ADMIN_TOKEN 优先，未配置时回退 AUTH_TOKEN。 */
export function getAdminToken(): string {
  return getEnv('ADMIN_TOKEN') || getEnv('AUTH_TOKEN');
}

/** 可读看板的全部凭证（去空）。 */
export function getStatsTokens(): string[] {
  return [getEnv('STATS_TOKEN'), getEnv('AUTH_TOKEN'), getEnv('ADMIN_TOKEN')]
    .filter((token): token is string => !!token);
}

let warnedOpenAuth = false;
let warnedUnconfigured = false;

/**
 * 校验客户端 token。返回值区分「凭证错误」与「服务端未配置」：后者是部署问题，
 * 用 503 暴露出来，运维才不会把它误读成客户端填错了 key。
 */
function checkClientToken(token: string, allowDummy: boolean): 'ok' | 'invalid' | 'unconfigured' {
  // dummy 仅允许显式开启，避免生产实例被公开调用。
  if (token === 'dummy') {
    return allowDummy && getEnv('ALLOW_DUMMY_TOKEN') === 'true' ? 'ok' : 'invalid';
  }

  const validAuthToken = getEnv('AUTH_TOKEN');
  if (validAuthToken) {
    return timingSafeEqual(token, validAuthToken) ? 'ok' : 'invalid';
  }

  if (isOpenAuthAllowed()) {
    if (!warnedOpenAuth) {
      warnedOpenAuth = true;
      console.warn('⚠️ ALLOW_OPEN_AUTH=true 且未配置 AUTH_TOKEN：任意 ≥10 字符的 token 都会被接受');
    }
    return token.length >= 10 ? 'ok' : 'invalid';
  }

  if (!warnedUnconfigured) {
    warnedUnconfigured = true;
    console.error('❌ 未配置 AUTH_TOKEN，所有受保护请求将被拒绝（本地开发可设 ALLOW_OPEN_AUTH=true）');
  }
  return 'unconfigured';
}

function authErrorResponse(c: Context, error: AuthError) {
  console.warn('⚠️ Authentication failed:', {
    code: error.code,
    message: error.message,
  });
  return c.json({
    type: 'error',
    error: {
      type: error.statusCode === 503 ? 'api_error' : 'authentication_error',
      message: error.message,
      code: error.code,
    },
  }, error.statusCode as 401);
}

const UNCONFIGURED = () =>
  new AuthError('Server authentication is not configured', 503, 'AUTH_NOT_CONFIGURED');

/**
 * 认证中间件工厂函数
 * @param options 配置选项
 */
export function createAuthMiddleware(options: {
  required?: boolean; // 是否必须认证
  allowDummy?: boolean; // 是否允许 "dummy" token (用于 Claude Code)
} = {}) {
  const { required = true, allowDummy = true } = options;

  return async function authMiddleware(c: Context, next: Next) {
    try {
      // 检查是否提供了任何认证 header
      const hasAuth = c.req.header('authorization') || c.req.header('x-api-key');

      // 如果不是必须认证且没有提供 header，则跳过
      if (!required && !hasAuth) {
        return await next();
      }

      // 提取 token (支持 Bearer 和 x-api-key)
      const { token, type } = extractAuthToken(c);

      const verdict = checkClientToken(token, allowDummy);
      if (verdict === 'unconfigured') throw UNCONFIGURED();
      if (verdict === 'invalid') throw new AuthError('Invalid token', 401, 'INVALID_TOKEN');

      // 将认证信息存储到 context
      c.set(
        'auth',
        {
          token,
          type,
        } satisfies AuthInfo,
      );

      await next();
    } catch (error) {
      if (error instanceof AuthError) return authErrorResponse(c, error);

      // 其他错误
      console.error('❌ Auth middleware error:', error);
      return c.json({
        type: 'error',
        error: {
          type: 'api_error',
          message: 'Internal authentication error',
        },
      }, 500);
    }
  };
}

/**
 * 管理操作鉴权：只认 ADMIN_TOKEN（未配置回退 AUTH_TOKEN），开放模式与 dummy 均不适用。
 */
export async function requireAdmin(c: Context, next: Next) {
  try {
    const { token } = extractAuthToken(c);
    const adminToken = getAdminToken();
    if (!adminToken) throw UNCONFIGURED();
    if (!timingSafeEqual(token, adminToken)) {
      throw new AuthError('Invalid admin token', 401, 'INVALID_TOKEN');
    }
    return await next();
  } catch (error) {
    if (error instanceof AuthError) return authErrorResponse(c, error);
    throw error;
  }
}

/**
 * 客户端 token 是否可以直接当 Sider 凭证使用。默认关闭：服务端未配置
 * SIDER_AUTH_TOKEN 时，不应把调用方提交的凭证转发给第三方。
 */
export function siderTokenFor(configured: string, clientToken: string): string {
  if (configured) return configured;
  return getEnv('SIDER_TOKEN_PASSTHROUGH') === 'true' ? clientToken : '';
}

/**
 * 获取当前请求的认证信息
 */
export function getAuthInfo(c: Context): AuthInfo | undefined {
  return c.get('auth');
}

/**
 * 要求认证的中间件 (简化版本)
 */
export const requireAuth = createAuthMiddleware({ required: true, allowDummy: true });

/**
 * 可选认证的中间件
 */
export const optionalAuth = createAuthMiddleware({ required: false, allowDummy: true });
