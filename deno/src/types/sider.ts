

/**
 * Sider AI API 类型定义
 * 基于用户提供的 API 格式示例
 * URL: https://sider.ai/api/chat/v1/completions
 */

// 多内容项类型
export interface SiderMultiContent {
  type: 'text';
  text: string;
  user_input_text: string;
}

// 工具配置类型 - 基于真实Sider API格式
export interface SiderTools {
  auto: string[];  // 可用工具名称数组
  image?: {        // 图像生成工具配置
    quality_level: "high" | "medium" | "low";
  };
  search?: {       // 网络搜索工具配置
    enabled: boolean;
    max_results?: number;
  };
  web_browse?: {   // 网页浏览工具配置
    enabled: boolean;
    timeout?: number;
  };
  // 扩展其他工具配置
  [key: string]: any;
}

// Sider API 请求类型
export interface SiderRequest {
  cid: string;
  parent_message_id?: string; // 可选字段，新会话时可能为空
  model: string; // 如: "claude-3.7-sonnet-think", "claude-4-sonnet-think"
  from: string; // 通常为 "chat"
  filter_search_history?: boolean; // 是否过滤搜索历史
  chat_models?: string[]; // 聊天模型列表
  quote?: any; // 引用信息
  client_prompt?: Record<string, unknown>; // 客户端提示（可选）
  multi_content: SiderMultiContent[];
  prompt_templates: Array<{
    key: string;
    attributes: Record<string, any>;
  }>;
  tools: SiderTools;
  extra_info?: {
    origin_url: string;
    origin_title: string;
  };
  output_language?: string; // 输出语言，如 "zh-CN"
}

// SSE 响应的基础类型
export interface SiderSSEResponse {
  code: number;
  msg: string;
  data: SiderResponseData;
}

// 响应数据联合类型
export type SiderResponseData = 
  | SiderCreditInfo 
  | SiderMessageStart 
  | SiderReasoningContent 
  | SiderTextContent
  | SiderToolCallStart
  | SiderToolCallProgress
  | SiderToolCallResult;

// 配额信息类型
export interface SiderCreditInfo {
  type: 'credit_info';
  model: string;
  credit_info: {
    type: 'advanced' | 'basic';
    info: {
      period: string; // 如: "monthly"
      reset_time: number;
      total: number;
      remain: number;
      used: number;
      extra_total: number;
      extra_quota: number;
    };
  };
}

// 消息开始类型
export interface SiderMessageStart {
  type: 'message_start';
  model: string;
  message_start: {
    cid: string;
    user_message_id: string;
    assistant_message_id: string;
  };
}

// 推理内容类型 (think 模型特有)
export interface SiderReasoningContent {
  type: 'reasoning_content';
  model: string;
  reasoning_content: {
    status: 'start' | 'processing' | 'finish';
    text: string;
  };
}

// 文本内容类型
export interface SiderTextContent {
  type: 'text';
  model: string;
  text: string;
}

// 解析后的完整响应类型
export interface SiderParsedResponse {
  creditInfo?: SiderCreditInfo;
  messageStart?: SiderMessageStart;
  reasoningParts: string[]; // 推理过程文本片段
  textParts: string[]; // 最终回答文本片段
  toolResults?: Array<{    // 工具调用结果数组
    toolName: string;
    toolId: string;
    result: any;
    status: 'start' | 'processing' | 'finish';
    error?: string;
  }>;
  model: string;
  conversationId?: string;
  messageIds?: {
    user: string;
    assistant: string;
  };
}

// 工具调用开始类型
export interface SiderToolCallStart {
  type: 'tool_call_start';
  model: string;
  tool_call: {
    id: string;
    name: string;
    status: 'start';
  };
}

// 工具调用进行中类型
export interface SiderToolCallProgress {
  type: 'tool_call_progress';
  model: string;
  tool_call: {
    id: string;
    name: string;
    status: 'processing';
    progress?: string;
  };
}

// 工具调用结果类型
export interface SiderToolCallResult {
  type: 'tool_call_result';
  model: string;
  tool_call: {
    id: string;
    name: string;
    status: 'finish';
    result: any;
    error?: string;
  };
}

// 错误响应类型
export interface SiderErrorResponse {
  code: number;
  msg: string;
  data?: null;
}
