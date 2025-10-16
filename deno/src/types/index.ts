

/**
 * 类型定义入口文件
 * 统一导出 Anthropic 和 Sider API 类型定义
 */

// 导出 Anthropic API 类型
export * from './anthropic.ts';

// 导出 Sider API 类型  
export * from './sider.ts';

// 通用基础类型
export interface BaseResponse {
  status: string;
  message?: string;
  error?: string;
}

export interface HealthResponse extends BaseResponse {
  service: string;
  version: string;
  timestamp: string;
  tech_stack?: string;
}

// API 转换相关类型
export interface ConversionContext {
  userToken: string;
  requestId: string;
  timestamp: number;
}

export interface ConversionError extends Error {
  code: string;
  statusCode: number;
  details?: unknown;
}
