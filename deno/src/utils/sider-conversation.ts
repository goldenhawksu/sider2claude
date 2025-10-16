/**
 * Sider 会话 API 客户端
 * 用于获取和管理真正的 Sider 会话历史
 */


// Sider 会话消息接口
export interface SiderConversationMessage {
  id: string;
  parent_message_id: string;
  current_child_id: string;
  model: string;
  role: 'user' | 'assistant';
  multi_content: Array<{
    type: 'text' | 'reasoning_content';
    text?: string;
    user_input_text?: string;
    reasoning_content?: {
      status: string;
      text: string;
    };
  }>;
  type: 'chat';
  created_at: string;
  client_prompt: Record<string, any>;
  is_error: boolean;
  app_name: string;
}

// Sider 会话信息接口
export interface SiderConversation {
  id: string;
  title: string;
  description: string;
  updated_at: string;
  root_leaf_message_id: string;
  current_leaf_message_id: string;
  provider: string;
  app_name: string;
  create_at: number;
}

// Sider 会话响应接口
export interface SiderConversationResponse {
  code: number;
  msg: string;
  data: {
    conversation: SiderConversation;
    messages: SiderConversationMessage[];
    has_more: boolean;
    next_sync_tag: {
      sync_time: string;
      tag: string;
      waiting_ids: string[];
    };
    latest_switch_list: Array<{
      message_id: string;
      current_child_id: string;
    }>;
  };
}

/**
 * Sider 会话 API 客户端类
 */
export class SiderConversationClient {
  private readonly baseURL = 'https://sider.ai/api/chat/v1/conversation/messages';
  private readonly timeout = 10000; // 10秒超时

  /**
   * 获取会话历史消息
   */
  async getConversationHistory(conversationId: string, authToken: string, limit: number = 200): Promise<SiderConversationResponse> {
    console.log('Fetching conversation history:', {
      conversationId: conversationId.substring(0, 10) + '...',
      limit,
    });

    try {
      const response = await fetch(this.baseURL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`,
          'Origin': 'chrome-extension://dhoenijjpgpeimemopealfcbiecgceod',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36 Edg/139.0.0.0',
          'X-Time-Zone': 'Asia/Shanghai',
          'X-App-Version': '5.13.0',
          'X-App-Name': 'ChitChat_Edge_Ext',
        },
        body: JSON.stringify({
          cid: conversationId,
          limit: limit,
        }),
        signal: AbortSignal.timeout(this.timeout),
      });

      if (!response.ok) {
        throw new Error(`Sider conversation API error: ${response.status} ${response.statusText}`);
      }

      const result = await response.json() as SiderConversationResponse;

      if (result.code !== 0) {
        throw new Error(`Sider conversation API error: ${result.msg || 'Unknown error'}`);
      }

      console.log('Conversation history fetched successfully:', {
        conversationId: result.data.conversation.id.substring(0, 10) + '...',
        messageCount: result.data.messages.length,
        hasMore: result.data.has_more,
        title: result.data.conversation.title,
      });

      return result;

    } catch (error) {
      console.error('Failed to fetch conversation history:', error);
      throw error;
    }
  }

  /**
   * 检查会话是否存在
   */
  async conversationExists(conversationId: string, authToken: string): Promise<boolean> {
    try {
      await this.getConversationHistory(conversationId, authToken, 1);
      return true;
    } catch (error) {
      console.debug('Conversation does not exist or is inaccessible:', {
        conversationId: conversationId.substring(0, 10) + '...',
        error: (error as Error).message,
      });
      return false;
    }
  }

  /**
   * 从会话历史构建上下文字符串
   */
  buildContextFromHistory(messages: SiderConversationMessage[], maxContextLength: number = 1000): string {
    if (messages.length === 0) {
      return '';
    }

    let context = '';
    
    // 按时间顺序处理消息，但限制总长度
    for (const message of messages) {
      const content = this.extractMessageText(message);
      if (!content) continue;

      const messageText = `${message.role === 'user' ? 'Human' : 'Assistant'}: ${content}\n`;
      
      // 检查是否会超出长度限制
      if (context.length + messageText.length > maxContextLength) {
        // 如果加上这条消息会超出限制，就截断并添加省略号
        const remainingLength = maxContextLength - context.length - 20; // 为省略号留空间
        if (remainingLength > 50) { // 只有足够空间时才添加部分内容
          context += messageText.substring(0, remainingLength) + '...\n';
        }
        break;
      }
      
      context += messageText;
    }

    console.debug('Built context from history:', {
      totalMessages: messages.length,
      contextLength: context.length,
      maxLength: maxContextLength,
    });

    return context;
  }

  /**
   * 从消息中提取文本内容
   */
  private extractMessageText(message: SiderConversationMessage): string {
    for (const content of message.multi_content) {
      if (content.type === 'text' && content.text) {
        return content.text;
      }
    }
    return '';
  }
}

// 导出单例实例
export const siderConversationClient = new SiderConversationClient();
