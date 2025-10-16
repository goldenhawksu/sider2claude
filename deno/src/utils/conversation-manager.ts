/**
 * 会话管理器 - 实现真正的会话保持
 * 管理会话ID、消息ID和会话状态
 */

import type { AnthropicMessage } from '../types/anthropic.ts';

// 会话状态接口
export interface ConversationState {
  id: string; // 会话ID (cid)
  lastMessageId: string; // 最后一条消息ID
  messageCount: number; // 消息计数
  createdAt: number; // 创建时间
  lastActivity: number; // 最后活动时间
}

// 内存中的会话存储（生产环境可替换为Redis等）
const conversationStore = new Map<string, ConversationState>();

/**
 * 基于消息历史生成会话指纹
 * 用于识别同一个对话的不同阶段
 */
function generateConversationFingerprint(messages: AnthropicMessage[]): string {
  // 使用前几条消息的内容hash来识别会话
  const firstFewMessages = messages.slice(0, 3).map(m => {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    return `${m.role}:${content.substring(0, 50)}`;
  }).join('|');
  
  // 简单hash算法（生产环境可使用更强的hash）
  let hash = 0;
  for (let i = 0; i < firstFewMessages.length; i++) {
    const char = firstFewMessages.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // 转为32位整数
  }
  
  return Math.abs(hash).toString(36);
}

/**
 * 生成消息ID
 */
function generateMessageId(conversationId: string, messageIndex: number): string {
  const timestamp = Date.now();
  return `${conversationId}_msg_${messageIndex}_${timestamp}`;
}

/**
 * 获取或创建会话状态
 */
export function getOrCreateConversation(messages: AnthropicMessage[]): ConversationState {
  const fingerprint = generateConversationFingerprint(messages);
  const conversationKey = `conv_${fingerprint}`;
  
  let conversation = conversationStore.get(conversationKey);
  
  if (!conversation) {
    // 创建新会话
    const now = Date.now();
    conversation = {
      id: conversationKey,
      lastMessageId: '',
      messageCount: 0,
      createdAt: now,
      lastActivity: now,
    };
    
    console.log('Creating new conversation:', {
      id: conversation.id,
      messageCount: messages.length,
      fingerprint: fingerprint.substring(0, 8)
    });
  } else {
    // 更新现有会话
    conversation.lastActivity = Date.now();
    
    console.log('Continuing existing conversation:', {
      id: conversation.id,
      previousMessageCount: conversation.messageCount,
      currentMessageCount: messages.length,
      age: Math.round((Date.now() - conversation.createdAt) / 1000) + 's'
    });
  }
  
  // 更新消息计数和ID
  conversation.messageCount = messages.length;
  conversation.lastMessageId = generateMessageId(conversation.id, conversation.messageCount);
  
  // 保存回存储
  conversationStore.set(conversationKey, conversation);
  
  return conversation;
}

/**
 * 获取父消息ID（用于链接对话）
 */
export function getParentMessageId(conversation: ConversationState, messages: AnthropicMessage[]): string {
  // 如果是第一条消息，没有父消息
  if (messages.length <= 1) {
    return '';
  }
  
  // 返回上一条消息的ID
  const previousMessageIndex = messages.length - 1;
  return generateMessageId(conversation.id, previousMessageIndex);
}

/**
 * 清理过期会话（可选的清理机制）
 */
export function cleanupExpiredConversations(maxAgeHours: number = 24): number {
  const maxAge = maxAgeHours * 60 * 60 * 1000; // 转为毫秒
  const now = Date.now();
  let cleanedCount = 0;
  
  for (const [key, conversation] of conversationStore.entries()) {
    if (now - conversation.lastActivity > maxAge) {
      conversationStore.delete(key);
      cleanedCount++;
    }
  }
  
  if (cleanedCount > 0) {
    console.log('Cleaned up expired conversations:', { count: cleanedCount });
  }
  
  return cleanedCount;
}

/**
 * 获取会话统计信息
 */
export function getConversationStats() {
  return {
    totalConversations: conversationStore.size,
    conversations: Array.from(conversationStore.entries()).map(([_key, conv]) => ({
      id: conv.id,
      messageCount: conv.messageCount,
      age: Math.round((Date.now() - conv.createdAt) / 1000),
      lastActivity: Math.round((Date.now() - conv.lastActivity) / 1000),
    }))
  };
}
