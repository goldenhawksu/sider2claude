/**
 * 请求格式转换器
 * 将 Anthropic API 请求转换为 Sider API 格式
 */

import type { AnthropicContent, AnthropicRequest, SiderRequest } from '../types';
import type { SiderTools } from '../types/sider';
import { consola } from 'consola';
// import { getOrCreateConversation, getParentMessageId } from './conversation-manager.js'; // Fallback functions, not used in current version
import { siderConversationClient } from './sider-conversation.js';
import { getNextParentMessageId, isContinuousConversation } from './sider-session-manager.js';
import { mapModelName } from '../config/models';

/**
 * 转换 Anthropic 请求到 Sider 格式（同步版本，用于新会话）
 */
export function convertAnthropicToSider(
  anthropicRequest: AnthropicRequest,
  conversationId?: string,
): SiderRequest {
  // 1. 提取最后一条用户消息（当前输入）
  const userMessages = anthropicRequest.messages.filter((msg) => msg.role === 'user');
  const lastUserMessage = userMessages[userMessages.length - 1];

  if (!lastUserMessage) {
    throw new Error('No user message found in request');
  }

  const currentUserInput = extractTextContent(lastUserMessage.content);
  const requestText = buildRequestText(anthropicRequest, currentUserInput, conversationId);
  const actualCid = getRealSiderConversationId(conversationId);
  const siderModel = mapModelName(anthropicRequest.model);

  // 2. 构建 Sider 请求
  const siderRequest: SiderRequest = {
    cid: actualCid, // 只使用真实的 Sider 会话ID
    model: siderModel,
    from: 'chat',
    filter_search_history: false,
    chat_models: [],
    quote: null,
    multi_content: [{
      type: 'text',
      text: requestText,
      user_input_text: currentUserInput,
    }],
    prompt_templates: [{
      key: 'artifacts',
      attributes: { lang: 'original' },
    }],
    tools: buildSafeToolsConfig(anthropicRequest),
    extra_info: {
      origin_url:
        'chrome-extension://dhoenijjpgpeimemopealfcbiecgceod/standalone.html?from=sidebar',
      origin_title: 'Sider',
    },
    output_language: 'zh-CN',
  };

  // 3. 只有真实 Sider 会话才尝试获取父消息ID
  if (actualCid) {
    try {
      const parentMessageId = getNextParentMessageId(actualCid);

      if (parentMessageId) {
        siderRequest.parent_message_id = parentMessageId;
        consola.info('Using existing conversation with parent message ID:', {
          conversationId: actualCid.substring(0, 10) + '...',
          parentMessageId: parentMessageId.substring(0, 10) + '...',
          messageCount: anthropicRequest.messages.length,
        });
      }
    } catch (error) {
      consola.warn('Failed to get parent message ID, continuing as new message:', error);
    }
  }

  consola.info('Converted Anthropic request to Sider format:', {
    conversationId: siderRequest.cid || 'new',
    textLength: requestText.length,
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
  conversationId?: string,
): Promise<SiderRequest> {
  consola.info('Converting Anthropic request to Sider async format:', {
    model: anthropicRequest.model,
    messageCount: anthropicRequest.messages.length,
    toolCount: anthropicRequest.tools?.length || 0,
    hasConversationId: !!conversationId,
  });

  // 1. 提取最后一条用户消息（当前输入）
  const userMessages = anthropicRequest.messages.filter((msg) => msg.role === 'user');
  const lastUserMessage = userMessages[userMessages.length - 1];

  if (!lastUserMessage) {
    throw new Error('No user message found in request');
  }

  const currentUserInput = extractTextContent(lastUserMessage.content);
  const siderModel = mapModelName(anthropicRequest.model);

  // 2. 检查是否是多轮对话且有会话ID
  const realConversationId = getRealSiderConversationId(conversationId);
  if (realConversationId && anthropicRequest.messages.length > 1) {
    try {
      // 尝试获取真正的 Sider 会话历史
      const historyResponse = await siderConversationClient.getConversationHistory(
        realConversationId,
        authToken,
        50, // 限制历史消息数量
      );

      // 构建包含历史的上下文
      const historyContext = siderConversationClient.buildContextFromHistory(
        historyResponse.data.messages,
        800, // 限制上下文长度
      );

      let requestText = currentUserInput;
      if (historyContext) {
        requestText = `Previous conversation:\n${historyContext}\nContinuing:\n${currentUserInput}`;
      }

      // 获取最新的父消息ID
      const latestMessage = historyResponse.data.messages[historyResponse.data.messages.length - 1];
      const parentMessageId = latestMessage ? latestMessage.id : '';

      const siderRequest: SiderRequest = {
        cid: realConversationId,
        parent_message_id: parentMessageId,
        model: siderModel,
        from: 'chat',
        client_prompt: buildSafeClientPrompt(anthropicRequest),
        multi_content: [{
          type: 'text',
          text: requestText,
          user_input_text: currentUserInput,
        }],
        prompt_templates: [],
        tools: buildSafeToolsConfig(anthropicRequest),
      };

      consola.info('Using real Sider conversation history:', {
        conversationId: realConversationId.substring(0, 10) + '...',
        historyMessageCount: historyResponse.data.messages.length,
        contextLength: historyContext.length,
        parentMessageId: parentMessageId.substring(0, 10) + '...',
        title: historyResponse.data.conversation.title,
      });

      return siderRequest;
    } catch (error) {
      consola.warn('Failed to get conversation history, falling back to basic mode:', error);
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
  conversationId?: string,
): SiderRequest {
  const userMessages = anthropicRequest.messages.filter((msg) => msg.role === 'user');
  const lastUserMessage = userMessages[userMessages.length - 1];

  if (!lastUserMessage) {
    throw new Error('No user message found in request');
  }

  const currentUserInput = extractTextContent(lastUserMessage.content);
  const siderModel = mapModelName(anthropicRequest.model);

  const requestText = buildRequestText(anthropicRequest, currentUserInput, conversationId);

  // 获取真实的父消息ID（如果有会话ID）
  let parentMessageId = '';
  const realConversationId = getRealSiderConversationId(conversationId);
  if (realConversationId && anthropicRequest.messages.length > 1) {
    parentMessageId = getNextParentMessageId(realConversationId);
    consola.debug('Using real parent message ID:', {
      cid: realConversationId.substring(0, 12) + '...',
      parentId: parentMessageId ? parentMessageId.substring(0, 12) + '...' : 'none',
    });
  }

  const actualCid = realConversationId;

  // 构建 Sider 请求
  const siderRequest: SiderRequest = {
    cid: actualCid, // 只使用真实的 Sider 会话ID
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

  consola.info('Simplified conversation request:', {
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
      .filter((item) => item.type === 'text' && item.text)
      .map((item) => item.text)
      .join('\n')
      .trim();
  }

  throw new Error('Invalid content format');
}

function buildRequestText(
  anthropicRequest: AnthropicRequest,
  currentUserInput: string,
  conversationId?: string,
): string {
  if (hasRealSiderConversation(conversationId) || anthropicRequest.messages.length === 1) {
    return buildSingleTurnText(anthropicRequest, currentUserInput);
  }

  return buildInlineHistoryText(anthropicRequest);
}

function hasRealSiderConversation(conversationId?: string): boolean {
  return !!conversationId && !isContinuousConversation(conversationId);
}

function getRealSiderConversationId(conversationId?: string): string {
  return hasRealSiderConversation(conversationId) ? conversationId! : '';
}

function buildSingleTurnText(
  anthropicRequest: AnthropicRequest,
  currentUserInput: string,
): string {
  if (anthropicRequest.system && anthropicRequest.messages.length === 1) {
    return `${anthropicRequest.system}\n\n${currentUserInput}`;
  }

  return currentUserInput;
}

function buildInlineHistoryText(anthropicRequest: AnthropicRequest): string {
  const parts: string[] = [];

  if (anthropicRequest.system) {
    parts.push(`System: ${anthropicRequest.system}`);
  }

  for (const message of anthropicRequest.messages) {
    const text = contentToTranscript(message.content).trim();
    if (!text) {
      continue;
    }

    const role = message.role === 'assistant' ? 'Assistant' : 'User';
    parts.push(`${role}: ${text}`);
  }

  parts.push('Assistant:');
  return parts.join('\n\n');
}

function contentToTranscript(content: string | AnthropicContent[]): string {
  if (typeof content === 'string') {
    return content;
  }

  return content
    .flatMap((block) => contentBlockToTranscript(block))
    .join('\n')
    .trim();
}

function contentBlockToTranscript(block: AnthropicContent): string[] {
  if (block.type === 'text') {
    return block.text ? [block.text] : [];
  }

  if (block.type === 'tool_use') {
    return [
      `[tool_use:${block.name || 'unknown'}] id=${block.id || ''} input=${
        JSON.stringify(block.input ?? {})
      }`,
    ];
  }

  if (block.type === 'tool_result') {
    const content = typeof block.content === 'string'
      ? block.content
      : Array.isArray(block.content)
      ? contentToTranscript(block.content)
      : '';
    return [
      `[tool_result] tool_use_id=${block.tool_use_id || ''}${
        block.is_error ? ' is_error=true' : ''
      }${content ? `\n${content}` : ''}`,
    ];
  }

  return [];
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
  const hasUserMessage = request.messages.some((msg) => msg.role === 'user');
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
  // 如果没有工具，返回空配置
  if (!anthropicRequest.tools || anthropicRequest.tools.length === 0) {
    return { auto: [] };
  }

  // 创建工具名称映射 - 将Anthropic工具名称映射到Sider工具名称
  const toolNameMapping: Record<string, string> = {
    // 常见工具映射
    'create_image': 'create_image',
    'generate_image': 'create_image',
    'image_generation': 'create_image',
    'web_search': 'search',
    'search_web': 'search',
    'internet_search': 'search',
    'browse_web': 'web_browse',
    'web_browsing': 'web_browse',
    'visit_url': 'web_browse',
    // 可扩展其他工具
  };

  // 转换工具列表
  const autoTools: string[] = [];
  const toolsConfig: SiderTools = { auto: autoTools };

  // 处理每个Anthropic工具
  anthropicRequest.tools.forEach((tool) => {
    const mappedName = toolNameMapping[tool.name] || tool.name;

    // 添加到auto数组
    if (!autoTools.includes(mappedName)) {
      autoTools.push(mappedName);
    }

    // 为特定工具添加配置
    switch (mappedName) {
      case 'create_image':
        toolsConfig.image = {
          quality_level: 'high', // 默认高质量
        };
        break;
      case 'search':
        toolsConfig.search = {
          enabled: true,
          max_results: 10, // 默认搜索结果数量
        };
        break;
      case 'web_browse':
        toolsConfig.web_browse = {
          enabled: true,
          timeout: 30, // 默认超时时间(秒)
        };
        break;
        // 可扩展其他工具配置
    }
  });

  // 记录转换结果
  consola.info('Tools converted from Anthropic to Sider format:', {
    anthropicTools: anthropicRequest.tools.map((t) => t.name),
    siderAutoTools: autoTools,
    toolsConfig: toolsConfig,
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
  if (
    anthropicRequest.temperature !== undefined && anthropicRequest.temperature >= 0 &&
    anthropicRequest.temperature <= 1
  ) {
    prompt.temperature = anthropicRequest.temperature;
  }

  return prompt;
}
