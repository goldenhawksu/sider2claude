

/**
 * 响应格式转换器
 * 将 Sider API 响应转换为 Anthropic API 格式
 */

import type { 
  SiderParsedResponse, 
  AnthropicResponse, 
  AnthropicResponseContent 
} from '../types.ts';

/**
 * 转换 Sider 响应到 Anthropic 格式
 */
export function convertSiderToAnthropic(
  siderResponse: SiderParsedResponse,
  originalModel: string
): AnthropicResponse {
  // 合并所有文本内容
  const fullText = combineTextParts(siderResponse);
  
  // 计算 token 使用量 (简单估算)
  const usage = estimateTokenUsage(siderResponse, fullText);
  
  // 生成响应 ID
  const responseId = generateResponseId();

  // 构建 Anthropic 响应
  const anthropicResponse: AnthropicResponse = {
    id: responseId,
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'text',
      text: fullText,
    }] satisfies AnthropicResponseContent[],
    model: originalModel, // 使用原始请求的模型名
    stop_reason: 'end_turn', // 正常结束
    usage: usage,
    // 包含 Sider 会话信息（如果有的话）
    ...(siderResponse.conversationId && siderResponse.messageIds ? {
      sider_session: {
        conversation_id: siderResponse.conversationId,
        message_ids: siderResponse.messageIds,
      }
    } : {}),
  };

  console.log('Response conversion completed:', {
    responseId,
    model: originalModel,
    textLength: fullText.length,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    hasReasoning: siderResponse.reasoningParts.length > 0,
    conversationId: siderResponse.conversationId ? siderResponse.conversationId.substring(0, 12) + '...' : 'none',
    hasSessionInfo: !!siderResponse.conversationId,
  });

  return anthropicResponse;
}

/**
 * 获取会话信息响应头
 * 用于客户端管理会话状态
 */
export function getSessionHeaders(siderResponse: SiderParsedResponse): Record<string, string> {
  const headers: Record<string, string> = {};
  
  if (siderResponse.conversationId) {
    headers['X-Conversation-ID'] = siderResponse.conversationId;
    
    if (siderResponse.messageIds?.assistant) {
      headers['X-Assistant-Message-ID'] = siderResponse.messageIds.assistant;
    }
    
    if (siderResponse.messageIds?.user) {
      headers['X-User-Message-ID'] = siderResponse.messageIds.user;
    }
  }
  
  return headers;
}

/**
 * 合并文本片段
 */
function combineTextParts(siderResponse: SiderParsedResponse): string {
  // 合并最终文本内容
  const finalText = siderResponse.textParts.join('').trim();
  
  if (!finalText) {
    // 如果没有最终文本，返回提示信息
    return 'Response received but no text content was generated.';
  }

  return finalText;
}

/**
 * 估算 token 使用量
 */
function estimateTokenUsage(
  siderResponse: SiderParsedResponse, 
  outputText: string
): { input_tokens: number; output_tokens: number } {
  // 简单的 token 估算 (1 token ≈ 4 字符)
  // 这里可以后续使用 gpt-tokenizer 进行精确计算
  
  const outputTokens = Math.ceil(outputText.length / 4);
  
  // 推理内容也计入输出 token (如果有的话)
  const reasoningLength = siderResponse.reasoningParts.join('').length;
  const reasoningTokens = Math.ceil(reasoningLength / 4);
  
  return {
    input_tokens: 10, // 暂时固定值，后续可以根据实际请求计算
    output_tokens: outputTokens + reasoningTokens,
  };
}

/**
 * 生成响应 ID
 */
function generateResponseId(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `msg_${timestamp}_${random}`;
}

/**
 * 创建错误响应
 */
export function createErrorResponse(
  error: Error,
  originalModel: string = 'unknown'
): AnthropicResponse {
  const responseId = generateResponseId();
  
  const errorResponse: AnthropicResponse = {
    id: responseId,
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'text',
      text: `Error: ${error.message}`,
    }],
    model: originalModel,
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 0,
      output_tokens: 0,
    },
  };

  console.error('Created error response:', {
    responseId,
    error: error.message,
    model: originalModel,
  });

  return errorResponse;
}

/**
 * 验证转换后的响应格式
 */
export function validateAnthropicResponse(response: AnthropicResponse): void {
  if (!response.id) {
    throw new Error('Response missing required field: id');
  }

  if (response.type !== 'message') {
    throw new Error('Response type must be "message"');
  }

  if (response.role !== 'assistant') {
    throw new Error('Response role must be "assistant"');
  }

  if (!Array.isArray(response.content) || response.content.length === 0) {
    throw new Error('Response content must be a non-empty array');
  }

  if (!response.model) {
    throw new Error('Response missing required field: model');
  }

  if (!response.usage || typeof response.usage.input_tokens !== 'number' || typeof response.usage.output_tokens !== 'number') {
    throw new Error('Response usage information is invalid');
  }
}
