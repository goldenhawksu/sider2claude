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
  claudeCodeToolNames: string[]; // Claude Code 工具名称
  mcpToolNames: string[]; // MCP 工具名称
  siderToolNames: string[]; // Sider 工具名称
  toolCount: number;
  messageCount: number;
  isMultiTurn: boolean;
  hasToolResult: boolean;
  /**
   * 消息里是否出现过图片块。
   *
   * 只看「有没有」而不看「在第几轮」：多轮视觉对话里图片往往只出现在首轮，
   * 但后续追问同样依赖模型看得见那张图，整段会话都必须留在支持视觉的后端。
   */
  hasImageContent: boolean;
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
    // 长文本判据只看**当前这一轮用户意图**，不看历史。见 detectLongFormSignals 的说明。
    const longFormSignals = this.detectLongFormSignals(
      this.extractLatestUserText(request),
      request,
    );
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
      hasImageContent: this.hasImageInMessages(request),
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
   * 消息里有没有图片块（含嵌在 tool_result 里的）。
   *
   * 扫描整段历史而不只看最后一轮：多轮视觉对话的图片通常只在首轮出现，
   * 后续追问依旧要求模型看得见它。
   */
  private hasImageInMessages(request: AnthropicRequest): boolean {
    return request.messages.some((message) => this.contentHasImage(message.content));
  }

  private contentHasImage(content: unknown): boolean {
    if (!Array.isArray(content)) {
      return false;
    }
    return content.some((item) => {
      if (!item || typeof item !== 'object') return false;
      const block = item as { type?: string; content?: unknown };
      if (block.type === 'image') return true;
      if (block.type === 'tool_result') return this.contentHasImage(block.content);
      return false;
    });
  }

  private extractRequestText(request: AnthropicRequest): string {    const parts: string[] = [];

    if (typeof request.system === 'string') {
      parts.push(request.system);
    }

    for (const message of request.messages) {
      parts.push(this.extractContentText(message.content));
    }

    return parts.join('\n').trim();
  }

  /**
   * 只取最后一条 user 消息的文本 —— 长文本判据的输入。
   *
   * 不能用整段对话：判据是「出现创作动词 且 出现长文体裁词」，而任何一段像样的
   * 编码对话里这两类词都必然出现（"写个脚本""整理成文档""改一下 README"）。
   * 用全文的结果是**对话越长越必然误判**，且与用户这一轮想干什么完全无关——
   * 实测最后一轮只说「请继续」也会被判成长文生成而路由去 DeepSeek。
   *
   * 同样排除 assistant 回复与 tool_result 内容：Read 出来的一个 README
   * 不代表用户要写 README。
   */
  private extractLatestUserText(request: AnthropicRequest): string {
    for (let index = request.messages.length - 1; index >= 0; index -= 1) {
      const message = request.messages[index];
      if (message?.role !== 'user') continue;
      const text = this.extractLatestUserBlocks(message.content);
      if (text.trim()) return text.trim();
    }
    return '';
  }

  /** 与 extractContentText 的差别：跳过 tool_result，它是工具产出不是用户意图。 */
  private extractLatestUserBlocks(content: unknown): string {
    if (typeof content === 'string') {
      return content;
    }
    if (!Array.isArray(content)) {
      return '';
    }
    return content
      .map((item) => {
        if (!item || typeof item !== 'object') return '';
        const block = item as { type?: string; text?: string };
        return block.type === 'text' && typeof block.text === 'string' ? block.text : '';
      })
      .filter(Boolean)
      .join('\n');
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
      /(做|制作|生成|输出|撰写|写|整理|设计|创建|起草|拟|改写|扩写|转换|转成|做成|生成一个|做一个)/
        .test(normalized) ||
      /\b(create|generate|write|draft|compose|prepare|turn into|convert into|make)\b/i.test(
        normalized,
      );
    const hasSourceMaterial =
      /(用以下内容|基于以下|根据以下|以下内容|素材如下|内容如下|source material|based on the following)/i
        .test(normalized);
    const presentationTarget =
      /\b(ppt|powerpoint|slide deck|slides?|presentation deck|presentation)\b/i.test(normalized) ||
      /(幻灯片|演示文稿|课件|汇报材料|路演材料)/.test(normalized);
    const longFormTarget =
      /(PPT|ppt|幻灯片|演示文稿|课件|报告|文档|方案|大纲|讲稿|演讲稿|文章|长文|白皮书|脚本|提纲|邮件|README|readme)/
        .test(normalized) ||
      /\b(report|document|doc|proposal|outline|article|essay|brief|script|deck|slides?)\b/i.test(
        normalized,
      );

    if (
      presentationTarget && (asksToCreate || hasSourceMaterial || (request.max_tokens || 0) >= 1024)
    ) {
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
      console.log(
        `│    - Tool Names: ${analysis.toolNames.join(', ').substring(0, 31).padEnd(31)}│`,
      );
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
