

/**
 * 认证中间件
 * 处理 Bearer token 认证，支持 Claude Code CLI 集成
 */

import type { Context, Next } from 'hono';
import { consola } from 'consola';

// 认证错误类型
export class AuthError extends Error {
  constructor(
    message: string,
    public statusCode: number = 401,
    public code: string = 'AUTH_ERROR'
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
    throw new AuthError('Invalid Authorization header format. Expected: Bearer <token>', 401, 'INVALID_AUTH_FORMAT');
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
      type: 'x-api-key'
    };
  }

  // 2. 检查 Authorization header (Bearer token)
  const authHeader = c.req.header('authorization');
  if (authHeader) {
    const token = extractBearerToken(authHeader);
    return {
      token,
      type: 'bearer'
    };
  }

  // 3. 都没有，抛出错误
  throw new AuthError('Missing authentication. Provide either "Authorization: Bearer <token>" or "x-api-key: <token>" header', 401, 'MISSING_AUTH');
}

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

      // 验证 token (目前简单验证，后续可扩展)
      if (!isValidToken(token, allowDummy)) {
        throw new AuthError('Invalid token', 401, 'INVALID_TOKEN');
      }

      // 将认证信息存储到 context
      c.set('auth', {
        token,
        type,
      } satisfies AuthInfo);

      // 日志记录 (不记录完整 token)
      consola.debug('Auth successful:', {
        tokenPrefix: token.substring(0, 8) + '...',
        type,
      });

      await next();
    } catch (error) {
      if (error instanceof AuthError) {
        consola.warn('Authentication failed:', {
          code: error.code,
          message: error.message,
        });

        return c.json({
          error: {
            type: 'authentication_error',
            message: error.message,
            code: error.code,
          },
        }, error.statusCode as 401);
      }

      // 其他错误
      consola.error('Auth middleware error:', error);
      return c.json({
        error: {
          type: 'api_error',
          message: 'Internal authentication error',
        },
      }, 500);
    }
  };
}

/**
 * 验证 token 是否有效
 * @param token Bearer token
 * @param allowDummy 是否允许 dummy token
 */
function isValidToken(token: string, allowDummy: boolean): boolean {
  // 从环境变量获取有效的 AUTH_TOKEN
  const validAuthToken = process.env.AUTH_TOKEN || Bun?.env?.AUTH_TOKEN || Deno?.env?.get?.('AUTH_TOKEN');

  // 如果环境变量中配置了 AUTH_TOKEN,则必须匹配
  if (validAuthToken) {
    return token === validAuthToken;
  }

  // 向后兼容: 如果没有配置 AUTH_TOKEN,使用旧的验证逻辑

  // Claude Code 使用 "dummy" token
  if (allowDummy && token === 'dummy') {
    return true;
  }

  // 基本格式验证 (可以根据需要扩展)
  if (token.length < 10) {
    return false;
  }

  // 这里可以添加更复杂的 token 验证逻辑
  // 例如: JWT 验证、数据库查询等

  return true;
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
