/**
 * 请求分析器 (Deno 版本)
 * 分析 Anthropic 请求的特征,用于路由决策
 */

import type { AnthropicRequest } from '../types/anthropic.ts';

export type RequestType = 'simple_chat' | 'tool_call' | 'tool_result_feedback';

export interface RequestAnalysis {
  type: RequestType;
  hasClaudeCodeTools: boolean;
  hasMcpTools: boolean;
  hasSiderTools: boolean;
  hasLongFormGenerationIntent: boolean;
  longFormSignals: string[];
  inputCharCount: number;
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
    const inputText = this.extractRequestText(request);
    const longFormSignals = this.detectLongFormSignals(inputText, request);
    const analysis: RequestAnalysis = {
      type: this.detectRequestType(request),
      hasClaudeCodeTools: false,
      hasMcpTools: false,
      hasSiderTools: false,
      hasLongFormGenerationIntent: longFormSignals.length > 0,
      longFormSignals,
      inputCharCount: inputText.length,
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

  private extractRequestText(request: AnthropicRequest): string {
    const parts: string[] = [];

    if (typeof request.system === 'string') {
      parts.push(request.system);
    }

    for (const message of request.messages) {
      parts.push(this.extractContentText(message.content));
    }

    return parts.join('\n').trim();
  }

  private extractContentText(content: unknown): string {
    if (typeof content === 'string') {
      return content;
    }

    if (!Array.isArray(content)) {
      return '';
    }

    return content
      .map((item) => {
        if (!item || typeof item !== 'object') {
          return '';
        }

        const block = item as {
          type?: string;
          text?: string;
          thinking?: string;
          content?: unknown;
        };

        if (typeof block.text === 'string') {
          return block.text;
        }

        if (typeof block.thinking === 'string') {
          return block.thinking;
        }

        if (block.type === 'tool_result') {
          return this.extractContentText(block.content);
        }

        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  private detectLongFormSignals(text: string, request: AnthropicRequest): string[] {
    const signals = new Set<string>();
    const normalized = text.replace(/\s+/g, ' ').trim();
    const lowerText = normalized.toLowerCase();

    const asksToCreate =
      /(做|制作|生成|输出|撰写|写|整理|设计|创建|起草|拟|改写|扩写|转换|转成|做成|生成一个|做一个)/.test(normalized) ||
      /\b(create|generate|write|draft|compose|prepare|turn into|convert into|make)\b/i.test(normalized);
    const hasSourceMaterial =
      /(用以下内容|基于以下|根据以下|以下内容|素材如下|内容如下|source material|based on the following)/i.test(normalized);
    const presentationTarget =
      /\b(ppt|powerpoint|slide deck|slides?|presentation deck|presentation)\b/i.test(normalized) ||
      /(幻灯片|演示文稿|课件|汇报材料|路演材料)/.test(normalized);
    const longFormTarget =
      /(PPT|ppt|幻灯片|演示文稿|课件|报告|文档|方案|大纲|讲稿|演讲稿|文章|长文|白皮书|脚本|提纲|邮件|README|readme)/.test(normalized) ||
      /\b(report|document|doc|proposal|outline|article|essay|brief|script|deck|slides?)\b/i.test(normalized);

    if (presentationTarget && (asksToCreate || hasSourceMaterial || (request.max_tokens || 0) >= 1024)) {
      signals.add('presentation');
    }

    if (asksToCreate && longFormTarget) {
      signals.add('long_form_creation');
    }

    const longInputThreshold = request.max_tokens && request.max_tokens >= 1024 ? 300 : 500;
    if (hasSourceMaterial && asksToCreate && normalized.length >= longInputThreshold) {
      signals.add('source_material_generation');
    }

    if (lowerText.includes('<ide_opened_file>')) {
      signals.delete('long_form_creation');
      signals.delete('source_material_generation');
    }

    return [...signals];
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
   * 打印分析结果(调试用)
   */
  logAnalysis(analysis: RequestAnalysis, debugMode: boolean = false): void {
    if (!debugMode) return;

    console.log('╭────────────────📊 Request Analysis────────────────╮');
    console.log('│                                                   │');
    console.log(`│  Type: ${analysis.type.padEnd(44)}│`);
    console.log(`│  Message Count: ${analysis.messageCount.toString().padEnd(36)}│`);
    console.log(`│  Multi-turn: ${(analysis.isMultiTurn ? 'Yes' : 'No').padEnd(39)}│`);
    console.log(`│  Has Tool Result: ${(analysis.hasToolResult ? 'Yes' : 'No').padEnd(34)}│`);
    console.log('│                                                   │');
    console.log(`│  Tools (${analysis.toolCount}):                                       │`);

    if (analysis.toolCount > 0) {
      console.log(`│    - Claude Code: ${(analysis.hasClaudeCodeTools ? '✅' : '❌').padEnd(31)}│`);
      console.log(`│    - MCP Server: ${(analysis.hasMcpTools ? '✅' : '❌').padEnd(32)}│`);
      console.log(`│    - Sider Native: ${(analysis.hasSiderTools ? '✅' : '❌').padEnd(30)}│`);
      console.log(`│    - Tool Names: ${analysis.toolNames.join(', ').substring(0, 31).padEnd(31)}│`);
    } else {
      console.log('│    (No tools)                                     │');
    }

    console.log('│                                                   │');
    console.log('╰───────────────────────────────────────────────────╯');
  }
}

/**
 * 创建默认分析器实例
 */
export const requestAnalyzer = new RequestAnalyzer();
