/**
 * Complete API 转换工具
 * 将 Anthropic Complete API 请求转换为 Messages API 格式
 */

import type { CompleteRequest, CompleteResponse, CompleteValidationError } from '../types/complete.ts';
import type { AnthropicRequest, AnthropicResponse } from '../types/anthropic.ts';

/**
 * 验证 Complete 请求
 */
export function validateCompleteRequest(req: Partial<CompleteRequest>): CompleteValidationError[] {
  const errors: CompleteValidationError[] = [];

  if (!req.model || typeof req.model !== 'string') {
    errors.push({ field: 'model', message: 'model is required and must be a string' });
  }

  if (!req.prompt || typeof req.prompt !== 'string') {
    errors.push({ field: 'prompt', message: 'prompt is required and must be a string' });
  }

  if (!req.max_tokens_to_sample || typeof req.max_tokens_to_sample !== 'number') {
    errors.push({
      field: 'max_tokens_to_sample',
      message: 'max_tokens_to_sample is required and must be a number'
    });
  } else if (req.max_tokens_to_sample < 1) {
    errors.push({
      field: 'max_tokens_to_sample',
      message: 'max_tokens_to_sample must be at least 1'
    });
  }

  if (req.temperature !== undefined) {
    if (typeof req.temperature !== 'number' || req.temperature < 0 || req.temperature > 1) {
      errors.push({ field: 'temperature', message: 'temperature must be between 0.0 and 1.0' });
    }
  }

  if (req.top_p !== undefined) {
    if (typeof req.top_p !== 'number' || req.top_p < 0 || req.top_p > 1) {
      errors.push({ field: 'top_p', message: 'top_p must be between 0.0 and 1.0' });
    }
  }

  return errors;
}

/**
 * 解析 Complete 格式的 prompt
 * 格式: "\n\nHuman: {message}\n\nAssistant:"
 */
export function parseCompletePrompt(prompt: string): { role: 'user' | 'assistant'; content: string }[] {
  const messages: { role: 'user' | 'assistant'; content: string }[] = [];

  // 移除开头的空白
  let text = prompt.trim();

  // 按 "\n\nHuman:" 和 "\n\nAssistant:" 分割
  const parts = text.split(/\n\n(Human|Assistant):\s*/);

  for (let i = 1; i < parts.length; i += 2) {
    const role = parts[i].toLowerCase() as 'human' | 'assistant';
    const content = parts[i + 1]?.trim() || '';

    if (content) {
      messages.push({
        role: role === 'human' ? 'user' : 'assistant',
        content
      });
    }
  }

  // 如果没有解析到任何消息，将整个 prompt 作为 user 消息
  if (messages.length === 0) {
    messages.push({
      role: 'user',
      content: text
    });
  }

  // 移除最后的 "Assistant:" 提示（如果存在）
  if (messages.length > 0) {
    const lastMsg = messages[messages.length - 1];
    if (lastMsg.role === 'user' && lastMsg.content.endsWith('Assistant:')) {
      lastMsg.content = lastMsg.content.replace(/\s*Assistant:\s*$/, '').trim();
    }
  }

  return messages;
}

/**
 * 将 Complete 请求转换为 Messages 请求
 */
export function convertCompleteToMessages(completeReq: CompleteRequest): AnthropicRequest {
  // 解析 prompt 为 messages 数组
  const messages = parseCompletePrompt(completeReq.prompt);

  // 构建 Messages API 请求
  const messagesReq: AnthropicRequest = {
    model: completeReq.model,
    max_tokens: completeReq.max_tokens_to_sample,
    messages: messages.map(msg => ({
      role: msg.role,
      content: msg.content
    })),
    stream: completeReq.stream || false
  };

  // 可选参数
  if (completeReq.temperature !== undefined) {
    messagesReq.temperature = completeReq.temperature;
  }

  if (completeReq.top_p !== undefined && completeReq.top_p !== -1) {
    messagesReq.top_p = completeReq.top_p;
  }

  if (completeReq.top_k !== undefined && completeReq.top_k !== -1) {
    messagesReq.top_k = completeReq.top_k;
  }

  if (completeReq.stop_sequences && completeReq.stop_sequences.length > 0) {
    messagesReq.stop_sequences = completeReq.stop_sequences;
  }

  if (completeReq.metadata) {
    messagesReq.metadata = completeReq.metadata;
  }

  return messagesReq;
}

/**
 * 将 Messages 响应转换为 Complete 响应
 */
export function convertMessagesToComplete(
  messagesResp: AnthropicResponse,
  originalModel: string
): CompleteResponse {
  // 提取文本内容
  let completion = '';
  for (const content of messagesResp.content) {
    if (content.type === 'text') {
      completion += content.text;
    }
  }

  // 构建 Complete 响应
  const completeResp: CompleteResponse = {
    id: messagesResp.id.replace('msg_', 'compl_'), // 转换 ID 格式
    type: 'completion',
    completion,
    model: originalModel,
    stop_reason: messagesResp.stop_reason === 'end_turn' ? 'stop_sequence' :
                 messagesResp.stop_reason === 'max_tokens' ? 'max_tokens' :
                 null,
    stop: messagesResp.stop_sequence || null
  };

  return completeResp;
}

/**
 * 提取 Complete 流式响应中的文本
 */
export function extractCompleteStreamText(chunk: string): string | null {
  try {
    const data = JSON.parse(chunk);
    if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta') {
      return data.delta.text;
    }
  } catch {
    // 忽略解析错误
  }
  return null;
}

/**
 * 生成 Complete 格式的流式响应
 */
export function createCompleteStreamChunk(text: string): string {
  return `data: ${JSON.stringify({
    type: 'completion',
    completion: text
  })}\n\n`;
}

/**
 * 生成 Complete 格式的流式结束块
 */
export function createCompleteStreamEnd(
  stopReason: 'stop_sequence' | 'max_tokens' | null,
  model: string,
  stop: string | null = null
): string {
  return `data: ${JSON.stringify({
    type: 'completion',
    completion: '',
    stop_reason: stopReason,
    model,
    stop
  })}\n\n`;
}
