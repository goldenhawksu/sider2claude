/**
 * 路由决策引擎 (Deno 版本)
 * 智能决定使用 Sider AI 还是 Anthropic API
 */

import type { AnthropicRequest } from '../types/anthropic.ts';
import type { Backend, BackendConfig } from '../config/backends.ts';
import type { RequestAnalysis } from '../utils/request-analyzer.ts';
import { RequestAnalyzer } from '../utils/request-analyzer.ts';

export interface RoutingDecision {
  backend: Backend;
  reason: string;
  confidence: number; // 0-1
  allowFallback: boolean;
  ruleId: string; // 用于调试和监控
}

function getBackendDisplayName(backend: Backend): string {
  return backend === 'sider' ? 'Sider AI' : 'Anthropic API';
}

/**
 * 路由决策引擎
 */
export class RouterEngine {
  private config: BackendConfig;
  private analyzer: RequestAnalyzer;
  private sessionBackends = new Map<string, Backend>(); // conversationId → backend

  constructor(config: BackendConfig) {
    this.config = config;
    this.analyzer = new RequestAnalyzer();
  }

  /**
   * 决定使用哪个后端
   */
  decide(request: AnthropicRequest, conversationId?: string): RoutingDecision {
    // 1. 分析请求
    const analysis = this.analyzer.analyze(request);

    // 打印分析结果(调试模式)
    this.analyzer.logAnalysis(analysis, this.config.routing.debugMode);

    // 2. 应用路由规则
    const decision = this.applyRoutingRules(analysis, conversationId);

    // 3. 打印决策结果
    this.logDecision(decision, analysis);

    return decision;
  }

  /**
   * 应用路由规则(优先级从高到低)
   */
  private applyRoutingRules(
    analysis: RequestAnalysis,
    conversationId?: string
  ): RoutingDecision {
    // 规则 1: 包含 tool_result,必须保持上一次的后端
    if (analysis.type === 'tool_result_feedback' && conversationId) {
      const previousBackend = this.sessionBackends.get(conversationId);
      if (previousBackend) {
        return {
          backend: previousBackend,
          reason: `Maintain backend for tool result feedback (previous: ${getBackendDisplayName(previousBackend)})`,
          confidence: 1.0,
          allowFallback: false, // 不允许降级,保持连续性
          ruleId: 'rule_1_tool_result_continuity',
        };
      }
    }

    // 规则 2: 包含 Claude Code 工具 → Anthropic API
    if (analysis.hasClaudeCodeTools) {
      if (!this.config.anthropic.enabled) {
        console.warn('⚠️ Claude Code tools detected but Anthropic API not configured');
        return {
          backend: 'sider',
          reason: 'Anthropic API required but not available, fallback to Sider (tools will not work)',
          confidence: 0.2,
          allowFallback: false,
          ruleId: 'rule_2_claude_tools_fallback',
        };
      }

      return {
        backend: 'anthropic',
        reason: `Request contains Claude Code tools: ${analysis.claudeCodeToolNames.slice(0, 3).join(', ')}`,
        confidence: 1.0,
        allowFallback: true,
        ruleId: 'rule_2_claude_tools',
      };
    }

    // 规则 3: 包含 MCP Server 工具 → Anthropic API
    if (analysis.hasMcpTools) {
      if (!this.config.anthropic.enabled) {
        console.warn('⚠️ MCP Server tools detected but Anthropic API not configured');
        return {
          backend: 'sider',
          reason: 'Anthropic API required for MCP tools but not available (tools will not work)',
          confidence: 0.2,
          allowFallback: false,
          ruleId: 'rule_3_mcp_tools_fallback',
        };
      }

      return {
        backend: 'anthropic',
        reason: `Request contains MCP Server tools: ${analysis.mcpToolNames.slice(0, 3).join(', ')}`,
        confidence: 1.0,
        allowFallback: true,
        ruleId: 'rule_3_mcp_tools',
      };
    }

    // 规则 4: 只包含 Sider 原生工具 → Sider AI (如果可用)
    if (analysis.hasSiderTools && !analysis.hasClaudeCodeTools && !analysis.hasMcpTools) {
      if (this.config.sider.enabled) {
        return {
          backend: 'sider',
          reason: `Request contains only Sider native tools: ${analysis.toolNames.join(', ')}`,
          confidence: 0.9,
          allowFallback: true,
          ruleId: 'rule_4_sider_tools',
        };
      }
    }

    // 规则 5: 纯对话请求 → 根据配置优先使用 Sider AI
    if (analysis.type === 'simple_chat') {
      if (this.config.routing.preferSiderForSimpleChat && this.config.sider.enabled) {
        return {
          backend: 'sider',
          reason: 'Simple chat, prefer Sider AI for cost optimization',
          confidence: 0.8,
          allowFallback: true,
          ruleId: 'rule_5_simple_chat_prefer_sider',
        };
      }

      // 如果不优先 Sider,或 Sider 不可用,使用 Anthropic
      if (this.config.anthropic.enabled) {
        return {
          backend: 'anthropic',
          reason: 'Simple chat, using Anthropic API',
          confidence: 0.7,
          allowFallback: true,
          ruleId: 'rule_5_simple_chat_anthropic',
        };
      }

      // 最后降级到 Sider(如果可用)
      if (this.config.sider.enabled) {
        return {
          backend: 'sider',
          reason: 'Simple chat, fallback to Sider AI',
          confidence: 0.6,
          allowFallback: false,
          ruleId: 'rule_5_simple_chat_fallback_sider',
        };
      }
    }

    // 规则 6: 默认规则 - 使用配置的默认后端
    const defaultBackend = this.config.routing.defaultBackend;
    if (defaultBackend === 'sider' && this.config.sider.enabled) {
      return {
        backend: 'sider',
        reason: 'Default backend (configured)',
        confidence: 0.6,
        allowFallback: true,
        ruleId: 'rule_6_default_sider',
      };
    }

    if (this.config.anthropic.enabled) {
      return {
        backend: 'anthropic',
        reason: 'Default backend or Sider not available',
        confidence: 0.6,
        allowFallback: false,
        ruleId: 'rule_6_default_anthropic',
      };
    }

    // 无可用后端(理论上不应该走到这里,因为启动时已验证)
    throw new Error('No backend available. This should not happen.');
  }

  /**
   * 记录会话的后端选择
   */
  recordSessionBackend(conversationId: string, backend: Backend): void {
    this.sessionBackends.set(conversationId, backend);
    console.log(`⚙️ Session backend recorded: ${conversationId.substring(0, 12)}... → ${getBackendDisplayName(backend)}`);
  }

  /**
   * 获取会话的后端
   */
  getSessionBackend(conversationId: string): Backend | undefined {
    return this.sessionBackends.get(conversationId);
  }

  /**
   * 清理过期会话(可选,避免内存泄漏)
   */
  cleanupExpiredSessions(_maxAge: number = 3600000): number {
    // 简单实现:清理所有会话(生产环境应该基于时间戳)
    const count = this.sessionBackends.size;
    this.sessionBackends.clear();
    console.log(`⚙️ Cleaned up ${count} session backend records`);
    return count;
  }

  /**
   * 打印决策结果
   */
  private logDecision(decision: RoutingDecision, analysis: RequestAnalysis): void {
    if (!this.config.routing.debugMode) {
      // 非调试模式,简洁日志
      console.log(
        `ℹ️ 🎯 Routing: ${getBackendDisplayName(decision.backend)} (${decision.ruleId})`
      );
      return;
    }

    // 调试模式,详细日志
    console.log('╭────────────────🎯 Routing Decision────────────────╮');
    console.log('│                                                   │');
    console.log(`│  Backend: ${getBackendDisplayName(decision.backend).padEnd(40)}│`);
    console.log(`│  Rule: ${decision.ruleId.padEnd(44)}│`);
    console.log(`│  Reason: ${decision.reason.substring(0, 42).padEnd(42)}│`);
    console.log(`│  Confidence: ${((decision.confidence * 100).toFixed(0) + '%').padEnd(38)}│`);
    console.log(`│  Allow Fallback: ${(decision.allowFallback ? 'Yes' : 'No').padEnd(34)}│`);
    console.log('│                                                   │');
    console.log('│  Context:                                         │');
    console.log(`│    Request Type: ${analysis.type.padEnd(32)}│`);
    console.log(`│    Tool Count: ${analysis.toolCount.toString().padEnd(34)}│`);
    console.log(`│    Claude Code Tools: ${(analysis.hasClaudeCodeTools ? 'Yes' : 'No').padEnd(28)}│`);
    console.log(`│    MCP Tools: ${(analysis.hasMcpTools ? 'Yes' : 'No').padEnd(36)}│`);
    console.log(`│    Sider Tools: ${(analysis.hasSiderTools ? 'Yes' : 'No').padEnd(34)}│`);
    console.log('│                                                   │');
    console.log('╰───────────────────────────────────────────────────╯');
  }

  /**
   * 获取路由统计信息(用于监控)
   */
  getStats(): {
    totalSessions: number;
    siderSessions: number;
    anthropicSessions: number;
  } {
    let siderCount = 0;
    let anthropicCount = 0;

    for (const backend of this.sessionBackends.values()) {
      if (backend === 'sider') {
        siderCount++;
      } else {
        anthropicCount++;
      }
    }

    return {
      totalSessions: this.sessionBackends.size,
      siderSessions: siderCount,
      anthropicSessions: anthropicCount,
    };
  }
}
