

/**
 * Anthropic API 类型定义
 * 参考: https://docs.anthropic.com/claude/reference/messages_post
 * 目标: 为 Claude Code CLI 提供完整的类型支持
 */

// 基础消息类型
export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContent[];
}

// 文本内容类型
export interface AnthropicTextContent {
  type: 'text';
  text: string;
}

// 图片内容类型  
export interface AnthropicImageContent {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

// 内容类型 (支持文本、图片和工具调用)
export type AnthropicContent = 
  | AnthropicTextContent 
  | AnthropicImageContent
  | AnthropicToolUse
  | AnthropicToolResult;

// 请求类型
export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  stream?: boolean;
  system?: string;
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  metadata?: {
    user_id?: string;
  };
}

// 响应类型 (非流式)
export interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: AnthropicResponseContent[];
  model: string;
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | null;
  stop_sequence?: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
  // Sider 会话信息 (自定义扩展)
  sider_session?: {
    conversation_id: string;
    message_ids?: {
      user: string;
      assistant: string;
    };
  };
}

// 响应内容类型
export interface AnthropicResponseContent {
  type: 'text';
  text: string;
}

// 流式响应事件类型
export interface AnthropicStreamEvent {
  type: 'message_start' | 'content_block_start' | 'content_block_delta' | 'content_block_stop' | 'message_delta' | 'message_stop';
  message?: Partial<AnthropicResponse>;
  content_block?: AnthropicResponseContent;
  delta?: {
    type: 'text_delta';
    text: string;
  };
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

// 错误响应类型
export interface AnthropicError {
  type: 'error';
  error: {
    type: 'invalid_request_error' | 'authentication_error' | 'permission_error' | 'not_found_error' | 'rate_limit_error' | 'api_error' | 'overloaded_error';
    message: string;
  };
}

// Token 计数请求类型 (支持 /v1/messages/count_tokens)
export interface AnthropicTokenCountRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string;
}

// Token 计数响应类型
export interface AnthropicTokenCountResponse {
  input_tokens: number;
}

// 工具调用相关类型
export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

export type AnthropicToolChoice = 
  | { type: 'auto' }
  | { type: 'any' }
  | { type: 'tool'; name: string };

export interface AnthropicToolUse {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, any>;
}

export interface AnthropicToolResult {
  type: 'tool_result';
  tool_use_id: string;
  content?: AnthropicContent[];
  is_error?: boolean;
}
