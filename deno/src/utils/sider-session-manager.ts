/**
 * Sider 会话管理器
 * 管理真实的 Sider API 会话ID和消息ID
 */


// Sider 会话状态接口
export interface SiderSessionState {
  cid: string; // 会话ID
  userMessageId: string; // 最后的用户消息ID
  assistantMessageId: string; // 最后的助手消息ID
  model: string; // 模型名称
  createdAt: number; // 创建时间
  lastActivity: number; // 最后活动时间
  messageCount: number; // 消息计数
}

// 内存中的会话存储（生产环境可替换为Redis等）
const siderSessionStore = new Map<string, SiderSessionState>();

/**
 * 保存或更新 Sider 会话状态
 */
export function saveSiderSession(
  cid: string,
  userMessageId: string,
  assistantMessageId: string,
  model: string
): SiderSessionState {
  const now = Date.now();
  
  let session = siderSessionStore.get(cid);
  
  if (!session) {
    // 创建新会话
    session = {
      cid,
      userMessageId,
      assistantMessageId,
      model,
      createdAt: now,
      lastActivity: now,
      messageCount: 1,
    };
    
    console.log('Created new Sider session:', {
      cid: cid.substring(0, 12) + '...',
      model,
    });
  } else {
    // 更新现有会话
    session.userMessageId = userMessageId;
    session.assistantMessageId = assistantMessageId;
    session.model = model;
    session.lastActivity = now;
    session.messageCount += 1;
    
    console.log('Updated Sider session:', {
      cid: cid.substring(0, 12) + '...',
      messageCount: session.messageCount,
      model,
    });
  }
  
  // 保存到存储
  siderSessionStore.set(cid, session);
  
  return session;
}

/**
 * 获取 Sider 会话状态
 */
export function getSiderSession(cid: string): SiderSessionState | undefined {
  return siderSessionStore.get(cid);
}

/**
 * 获取下次请求应该使用的父消息ID
 */
export function getNextParentMessageId(cid: string): string {
  const session = getSiderSession(cid);
  if (!session) {
    console.debug('No session found for CID:', cid.substring(0, 12) + '...');
    return '';
  }
  
  // 下次请求的 parent_message_id 应该是当前的 assistant_message_id
  console.debug('Using parent message ID:', {
    cid: cid.substring(0, 12) + '...',
    parentMessageId: session.assistantMessageId.substring(0, 12) + '...',
  });
  
  return session.assistantMessageId;
}

/**
 * 检查是否为连续对话会话
 */
export function isContinuousConversation(cid: string): boolean {
  return cid === 'continuous-conversation';
}

/**
 * 获取或创建连续对话会话
 */
export function getOrCreateContinuousSession(): SiderSessionState {
  const cid = 'continuous-conversation';
  let session = getSiderSession(cid);
  
  if (!session) {
    // 创建新的连续对话会话
    session = {
      cid,
      userMessageId: '',
      assistantMessageId: '',
      model: 'claude-3.7-sonnet-think',
      createdAt: Date.now(),
      lastActivity: Date.now(),
      messageCount: 0,
    };
    
    console.log('Created new continuous conversation session');
  }
  
  return session;
}

/**
 * 清理过期的 Sider 会话
 */
export function cleanupExpiredSiderSessions(maxAgeHours: number = 24): number {
  const maxAge = maxAgeHours * 60 * 60 * 1000;
  const now = Date.now();
  let cleanedCount = 0;
  
  for (const [cid, session] of siderSessionStore.entries()) {
    if (now - session.lastActivity > maxAge) {
      siderSessionStore.delete(cid);
      cleanedCount++;
    }
  }
  
  if (cleanedCount > 0) {
    console.log('Cleaned up expired Sider sessions:', { count: cleanedCount });
  }
  
  return cleanedCount;
}

/**
 * 获取 Sider 会话统计信息
 */
export function getSiderSessionStats() {
  return {
    totalSessions: siderSessionStore.size,
    sessions: Array.from(siderSessionStore.entries()).map(([cid, session]) => ({
      cid: cid.substring(0, 12) + '...',
      model: session.model,
      messageCount: session.messageCount,
      age: Math.round((Date.now() - session.createdAt) / 1000),
      lastActivity: Math.round((Date.now() - session.lastActivity) / 1000),
    }))
  };
}

