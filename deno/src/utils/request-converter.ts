

/**
 * 请求格式转换器
 * 将 Anthropic API 请求转换为 Sider API 格式
 */

import type { AnthropicRequest, SiderRequest } from '../types.ts';
import type { SiderTools } from '../types/sider.ts';
// import { getOrCreateConversation, getParentMessageId } from './conversation-manager.ts'; // Fallback functions, not used in current version
import { siderConversationClient } from './sider-conversation.ts';
import { getNextParentMessageId, isContinuousConversation, getOrCreateContinuousSession } from './sider-session-manager.ts';
import { mapModelName } from '../config/models.ts';

/**
 * 转换 Anthropic 请求到 Sider 格式（同步版本，用于新会话）
 */
export function convertAnthropicToSider(
  anthropicRequest: AnthropicRequest,
  conversationId?: string
): SiderRequest {
  // 1. 提取最后一条用户消息（当前输入）
  const userMessages = anthropicRequest.messages.filter(msg => msg.role === 'user');
  const lastUserMessage = userMessages[userMessages.length - 1];
  
  if (!lastUserMessage) {
    throw new Error('No user message found in request');
  }

  const currentUserInput = extractTextContent(lastUserMessage.content);
  const siderModel = mapModelName(anthropicRequest.model);

  // 2. 构建 Sider 请求
  const siderRequest: SiderRequest = {
    cid: conversationId || '', // 使用传入的会话ID，如果没有则为空字符串
    model: siderModel,
    from: 'chat',
    filter_search_history: false,
    chat_models: [],
    quote: null,
    multi_content: [{
      type: 'text',
      text: currentUserInput,
      user_input_text: currentUserInput,
    }],
    prompt_templates: [{
      key: 'artifacts',
      attributes: { lang: 'original' }
    }],
    tools: buildSafeToolsConfig(anthropicRequest),
    extra_info: {
      origin_url: 'chrome-extension://dhoenijjpgpeimemopealfcbiecgceod/standalone.html?from=sidebar',
      origin_title: 'Sider'
    },
    output_language: 'zh-CN'
  };

  // 3. 如果是多轮对话且有会话ID，尝试获取父消息ID
  if (conversationId && anthropicRequest.messages.length > 1) {
    try {
      let parentMessageId = '';
      
      if (isContinuousConversation(conversationId)) {
        // 连续对话会话，获取或创建会话状态
        const session = getOrCreateContinuousSession();
        if (session.assistantMessageId) {
          parentMessageId = session.assistantMessageId;
        }
      } else {
        // 真实会话ID，尝试获取父消息ID
        parentMessageId = getNextParentMessageId(conversationId);
      }
      
      if (parentMessageId) {
        siderRequest.parent_message_id = parentMessageId;
        console.log('Using existing conversation with parent message ID:', {
          conversationId: conversationId.substring(0, 10) + '...',
          parentMessageId: parentMessageId.substring(0, 10) + '...',
          messageCount: anthropicRequest.messages.length
        });
      }
    } catch (error) {
      console.warn('Failed to get parent message ID, continuing as new message:', error);
    }
  }

  console.log('Converted Anthropic request to Sider format:', {
    conversationId: siderRequest.cid || 'new',
    textLength: currentUserInput.length,
    messageCount: anthropicRequest.messages.length,
    model: siderModel,
    hasParentMessage: !!siderRequest.parent_message_id,
  });

  return siderRequest;
}

/**
 * 转换 Anthropic 请求到 Sider 格式（异步版本，支持真正的会话历史）
 */
export async function convertAnthropicToSiderAsync(
  anthropicRequest: AnthropicRequest,
  authToken: string,
  conversationId?: string
): Promise<SiderRequest> {
  console.log("@@@ anthropicRequest", anthropicRequest);

  // 1. 提取最后一条用户消息（当前输入）
  const userMessages = anthropicRequest.messages.filter(msg => msg.role === 'user');
  const lastUserMessage = userMessages[userMessages.length - 1];
  
  if (!lastUserMessage) {
    throw new Error('No user message found in request');
  }

  const currentUserInput = extractTextContent(lastUserMessage.content);
  const siderModel = mapModelName(anthropicRequest.model);

  // 2. ✅ 修复：只要有会话ID就尝试获取历史（不再检查消息数量）
  if (conversationId) {
    try {
      // 尝试获取真正的 Sider 会话历史
      const historyResponse = await siderConversationClient.getConversationHistory(
        conversationId,
        authToken,
        50 // 限制历史消息数量
      );

      // 获取最新的父消息ID
      const latestMessage = historyResponse.data.messages[historyResponse.data.messages.length - 1];
      const parentMessageId = latestMessage ? latestMessage.id : '';

      // ✅ 修复：不要手动拼接历史文本，Sider API 会通过 cid + parent_message_id 自动关联历史
      const siderRequest: SiderRequest = {
        cid: conversationId,
        parent_message_id: parentMessageId,
        model: siderModel,
        from: 'chat',
        client_prompt: buildSafeClientPrompt(anthropicRequest),
        multi_content: [{
          type: 'text',
          text: currentUserInput, // ✅ 只发送当前用户输入，不拼接历史
          user_input_text: currentUserInput,
        }],
        prompt_templates: [],
        tools: buildSafeToolsConfig(anthropicRequest),
      };

      console.log('Using real Sider conversation history:', {
        conversationId: conversationId.substring(0, 10) + '...',
        historyMessageCount: historyResponse.data.messages.length,
        parentMessageId: parentMessageId.substring(0, 10) + '...',
        title: historyResponse.data.conversation.title,
        onlyCurrentInput: true, // ✅ 标记：仅发送当前输入，依赖 Sider API 关联历史
      });

      return siderRequest;

    } catch (error) {
      console.warn('Failed to get conversation history, falling back to basic mode:', error);
      // 如果获取历史失败，降级到基本模式
    }
  }

  // 3. 降级到基本模式（新会话或历史获取失败）
  return convertAnthropicToSiderSync(anthropicRequest, conversationId);
}

/**
 * 同步版本的转换函数（用于新会话或降级模式）
 * 简化版本，确保稳定性
 */
export function convertAnthropicToSiderSync(
  anthropicRequest: AnthropicRequest,
  conversationId?: string
): SiderRequest {
  const userMessages = anthropicRequest.messages.filter(msg => msg.role === 'user');
  const lastUserMessage = userMessages[userMessages.length - 1];
  
  if (!lastUserMessage) {
    throw new Error('No user message found in request');
  }

  const currentUserInput = extractTextContent(lastUserMessage.content);
  const siderModel = mapModelName(anthropicRequest.model);

  // ✅ 修复：构建请求文本 - 仅添加系统消息，不拼接历史
  // 因为 Sider API 会通过 cid + parent_message_id 自动关联历史
  let requestText = currentUserInput;

  // 仅在新会话时添加系统消息
  if (anthropicRequest.system && anthropicRequest.messages.length === 1) {
    requestText = `${anthropicRequest.system}\n\n${currentUserInput}`;
  }

  // ✅ 修复：获取真实的父消息ID（只要有会话ID就尝试）
  let parentMessageId = '';
  if (conversationId) {
    parentMessageId = getNextParentMessageId(conversationId);
    if (parentMessageId) {
      console.debug('Using real parent message ID:', {
        cid: conversationId.substring(0, 12) + '...',
        parentId: parentMessageId.substring(0, 12) + '...',
      });
    }
  }

  // ⚠️ CRITICAL FIX: 检查是否是虚拟会话 ID
  // "continuous-conversation" 是内部使用的虚拟 ID，不能发送给 Sider API
  const actualCid = (conversationId && !isContinuousConversation(conversationId))
    ? conversationId
    : '';

  // 构建 Sider 请求
  const siderRequest: SiderRequest = {
    cid: actualCid, // 只使用真实的 Sider 会话ID，虚拟ID替换为空字符串
    parent_message_id: parentMessageId, // 使用真实的父消息ID
    model: siderModel,
    from: 'chat',
    client_prompt: buildSafeClientPrompt(anthropicRequest), // 使用buildSafeClientPrompt函数
    multi_content: [{
      type: 'text',
      text: requestText,
      user_input_text: currentUserInput,
    }],
    prompt_templates: [],
    tools: buildSafeToolsConfig(anthropicRequest), // 启用工具调用功能
  };

  console.log('Simplified conversation request:', {
    conversationId: siderRequest.cid || 'new',
    textLength: requestText.length,
    messageCount: anthropicRequest.messages.length,
    model: siderModel,
    mode: 'simplified',
  });

  return siderRequest;
}

/**
 * 提取消息的文本内容
 */
function extractTextContent(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    // 合并所有文本内容
    return content
      .filter(item => item.type === 'text' && item.text)
      .map(item => item.text)
      .join('\n')
      .trim();
  }

  throw new Error('Invalid content format');
}

// 模型映射函数已移至 ../config/models.ts，通过 import 引入

/**
 * 验证 Anthropic 请求格式
 */
export function validateAnthropicRequest(request: AnthropicRequest): void {
  if (!request.model) {
    throw new Error('Missing required field: model');
  }

  if (!request.messages || !Array.isArray(request.messages)) {
    throw new Error('Missing required field: messages');
  }

  if (request.messages.length === 0) {
    throw new Error('Messages array cannot be empty');
  }

  // 检查是否有用户消息
  const hasUserMessage = request.messages.some(msg => msg.role === 'user');
  if (!hasUserMessage) {
    throw new Error('At least one user message is required');
  }

  // 验证消息格式
  for (const message of request.messages) {
    if (!message.role || !['user', 'assistant'].includes(message.role)) {
      throw new Error('Invalid message role. Must be "user" or "assistant"');
    }

    if (!message.content) {
      throw new Error('Message content cannot be empty');
    }
  }
}

// 旧的假会话保持函数已移除，现在使用真正的会话管理器

/**
 * 构建安全的工具配置
 */
function buildSafeToolsConfig(anthropicRequest: AnthropicRequest): SiderTools {
  // ⚠️ CRITICAL FIX: Sider API 不支持 Anthropic 的自定义工具
  // Claude Code 发送的工具（Task, Bash, Read, Edit 等）是 Claude Code 特有的
  // Sider API 只支持自己的工具：search, web_browse, create_image
  // 解决方案：返回空工具配置，禁用所有工具调用

  // 如果没有工具，返回空配置
  if (!anthropicRequest.tools || anthropicRequest.tools.length === 0) {
    return { auto: [] };
  }

  // Sider API 支持的工具白名单
  const SIDER_SUPPORTED_TOOLS = new Set([
    'search',
    'web_search',
    'search_web',
    'internet_search',
    'web_browse',
    'browse_web',
    'web_browsing',
    'visit_url',
    'create_image',
    'generate_image',
    'image_generation'
  ]);

  // 工具名称映射
  const toolNameMapping: Record<string, string> = {
    'web_search': 'search',
    'search_web': 'search',
    'internet_search': 'search',
    'browse_web': 'web_browse',
    'web_browsing': 'web_browse',
    'visit_url': 'web_browse',
    'generate_image': 'create_image',
    'image_generation': 'create_image',
  };

  // 转换工具列表 - 只保留 Sider 支持的工具
  const autoTools: string[] = [];
  const toolsConfig: SiderTools = { auto: autoTools };

  anthropicRequest.tools.forEach(tool => {
    // 检查是否是 Sider 支持的工具
    if (SIDER_SUPPORTED_TOOLS.has(tool.name)) {
      const mappedName = toolNameMapping[tool.name] || tool.name;

      // 添加到auto数组（去重）
      if (!autoTools.includes(mappedName)) {
        autoTools.push(mappedName);
      }

      // 为特定工具添加配置
      switch (mappedName) {
        case 'create_image':
          toolsConfig.image = {
            quality_level: 'high'
          };
          break;
        case 'search':
          toolsConfig.search = {
            enabled: true,
            max_results: 10
          };
          break;
        case 'web_browse':
          toolsConfig.web_browse = {
            enabled: true,
            timeout: 30
          };
          break;
      }
    }
  });

  // 记录转换结果（包括被过滤的工具）
  const filteredTools = anthropicRequest.tools
    .filter(t => !SIDER_SUPPORTED_TOOLS.has(t.name))
    .map(t => t.name);

  console.log('Tools converted from Anthropic to Sider format:', {
    anthropicTools: anthropicRequest.tools.map(t => t.name),
    siderAutoTools: autoTools,
    filteredOutTools: filteredTools.length > 0 ? filteredTools : 'none',
    toolsConfig: toolsConfig
  });

  return toolsConfig;
}

/**
 * 构建安全的客户端提示 - 避免 API 错误
 */
function buildSafeClientPrompt(anthropicRequest: AnthropicRequest): Record<string, any> {
  // 返回空对象避免可能的格式问题
  const prompt: Record<string, any> = {};

  // 暂时只保留基本参数
  if (anthropicRequest.temperature !== undefined && anthropicRequest.temperature >= 0 && anthropicRequest.temperature <= 1) {
    prompt.temperature = anthropicRequest.temperature;
  }

  return prompt;
}
