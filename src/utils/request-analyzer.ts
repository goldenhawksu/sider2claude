/**
 * 请求分析器
 * 分析 Anthropic 请求的特征，用于路由决策
 */

import type { AnthropicRequest } from '../types/anthropic';
import { consola } from 'consola';

export type RequestType = 'simple_chat' | 'tool_call' | 'tool_result_feedback';

export interface RequestAnalysis {
  type: RequestType;
  hasClaudeCodeTools: boolean;
  hasMcpTools: boolean;
  hasSiderTools: boolean;
  toolNames: string[];
  claudeCodeToolNames: string[];  // Claude Code 工具名称
  mcpToolNames: string[];          // MCP 工具名称
  siderToolNames: string[];        // Sider 工具名称
  toolCount: number;
  messageCount: number;
  isMultiTurn: boolean;
  hasToolResult: boolean;
}

/**
 * Claude Code 内置工具列表
 */
const CLAUDE_CODE_TOOLS = new Set([
  'Task',
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'NotebookEdit',
  'Skill',
  'SlashCommand',
  'ExitPlanMode',
  'AskUserQuestion',
]);

/**
 * Sider AI 原生工具列表
 */
const SIDER_NATIVE_TOOLS = new Set([
  'search',
  'web_search',
  'internet_search',
  'web_browse',
  'browse_web',
  'web_browsing',
  'create_image',
  'generate_image',
  'image_generation',
]);

/**
 * 请求分析器类
 */
export class RequestAnalyzer {
  /**
   * 分析请求特征
   */
  analyze(request: AnthropicRequest): RequestAnalysis {
    const analysis: RequestAnalysis = {
      type: this.detectRequestType(request),
      hasClaudeCodeTools: false,
      hasMcpTools: false,
      hasSiderTools: false,
      toolNames: [],
      claudeCodeToolNames: [],
      mcpToolNames: [],
      siderToolNames: [],
      toolCount: request.tools?.length || 0,
      messageCount: request.messages.length,
      isMultiTurn: request.messages.length > 1,
      hasToolResult: this.hasToolResultInMessages(request),
    };

    // 分析工具类型
    if (request.tools && request.tools.length > 0) {
      for (const tool of request.tools) {
        analysis.toolNames.push(tool.name);

        if (CLAUDE_CODE_TOOLS.has(tool.name)) {
          analysis.hasClaudeCodeTools = true;
          analysis.claudeCodeToolNames.push(tool.name);
        } else if (SIDER_NATIVE_TOOLS.has(tool.name)) {
          analysis.hasSiderTools = true;
          analysis.siderToolNames.push(tool.name);
        } else {
          // 其他工具视为 MCP 工具
          analysis.hasMcpTools = true;
          analysis.mcpToolNames.push(tool.name);
        }
      }
    }

    return analysis;
  }

  /**
   * 检测请求类型
   */
  private detectRequestType(request: AnthropicRequest): RequestType {
    // 检查是否包含 tool_result
    if (this.hasToolResultInMessages(request)) {
      return 'tool_result_feedback';
    }

    // 检查是否包含工具定义
    if (request.tools && request.tools.length > 0) {
      return 'tool_call';
    }

    return 'simple_chat';
  }

  /**
   * 检查消息中是否包含 tool_result
   */
  private hasToolResultInMessages(request: AnthropicRequest): boolean {
    for (const message of request.messages) {
      if (message.role === 'user' && Array.isArray(message.content)) {
        for (const content of message.content) {
          if (content.type === 'tool_result') {
            return true;
          }
        }
      }
    }
    return false;
  }

  /**
   * 打印分析结果（调试用）
   */
  logAnalysis(analysis: RequestAnalysis, debugMode: boolean = false): void {
    if (!debugMode) return;

    consola.box({
      title: '📊 Request Analysis',
      message: `
Type: ${analysis.type}
Message Count: ${analysis.messageCount}
Multi-turn: ${analysis.isMultiTurn ? 'Yes' : 'No'}
Has Tool Result: ${analysis.hasToolResult ? 'Yes' : 'No'}

Tools (${analysis.toolCount}):
${analysis.toolCount > 0 ? `  - Claude Code: ${analysis.hasClaudeCodeTools ? '✅' : '❌'}
  - MCP Server: ${analysis.hasMcpTools ? '✅' : '❌'}
  - Sider Native: ${analysis.hasSiderTools ? '✅' : '❌'}
  - Tool Names: ${analysis.toolNames.join(', ') || 'none'}` : '  (No tools)'}
      `.trim(),
      style: {
        borderColor: 'blue',
        borderStyle: 'rounded',
      },
    });
  }
}

/**
 * 创建默认分析器实例
 */
export const requestAnalyzer = new RequestAnalyzer();
