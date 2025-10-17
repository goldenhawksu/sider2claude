/**
 * Anthropic Complete API (Legacy) 类型定义
 *
 * 这是 Anthropic 的旧版 Text Completion API
 * 官方推荐使用 Messages API (/v1/messages)
 *
 * 文档: https://docs.anthropic.com/claude/reference/complete_post
 */

/**
 * Complete API 请求参数
 */
export interface CompleteRequest {
  /** 模型 ID */
  model: string;

  /**
   * 输入 prompt
   * 格式: "\n\nHuman: ...\n\nAssistant:"
   */
  prompt: string;

  /**
   * 最大生成 token 数
   * 注意: 参数名与 Messages API 的 max_tokens 不同
   */
  max_tokens_to_sample: number;

  /** 温度 (0-1) */
  temperature?: number;

  /** Top-p 采样 (0-1) */
  top_p?: number;

  /** Top-k 采样 */
  top_k?: number;

  /** 停止序列 */
  stop_sequences?: string[];

  /** 是否流式返回 */
  stream?: boolean;

  /** 元数据 */
  metadata?: {
    user_id?: string;
    [key: string]: unknown;
  };
}

/**
 * Complete API 响应
 */
export interface CompleteResponse {
  /** 响应 ID */
  id: string;

  /** 响应类型 */
  type: 'completion';

  /** 生成的文本 */
  completion: string;

  /** 模型 ID */
  model: string;

  /** 停止原因 */
  stop_reason: 'stop_sequence' | 'max_tokens' | null;

  /** 触发的停止序列 */
  stop?: string | null;
}

/**
 * Complete API 流式响应块
 */
export interface CompleteStreamChunk {
  type: 'completion';
  completion: string;
  stop_reason?: 'stop_sequence' | 'max_tokens' | null;
  model?: string;
  stop?: string | null;
}

/**
 * Complete API 错误响应
 */
export interface CompleteError {
  type: 'error';
  error: {
    type: 'invalid_request_error' | 'authentication_error' | 'permission_error' | 'not_found_error' | 'rate_limit_error' | 'api_error' | 'overloaded_error';
    message: string;
  };
}

/**
 * Complete 请求验证错误
 */
export interface CompleteValidationError {
  field: string;
  message: string;
}
