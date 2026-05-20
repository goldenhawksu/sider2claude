/**
 * 后端能力路由引擎。
 *
 * Sider 是 Claude 模型对话的首选来源；DeepSeek 作为 Anthropic 兼容后端，
 * 用来补齐 Sider 当前无法可靠提供的工具调用、MCP 工具等能力。
 */

import type { AnthropicRequest } from '../types/anthropic';
import type { Backend, BackendConfig } from '../config/backends';
import { getBackendDisplayName } from '../config/backends';
import type { RequestAnalysis } from '../utils/request-analyzer';
import { RequestAnalyzer } from '../utils/request-analyzer';
import { consola } from 'consola';

export interface RoutingDecision {
  backend: Backend;
  reason: string;
  confidence: number;
  allowFallback: boolean;
  ruleId: string;
}

export class RouterEngine {
  private config: BackendConfig;
  private analyzer: RequestAnalyzer;
  private sessionBackends = new Map<string, Backend>();

  constructor(config: BackendConfig) {
    this.config = config;
    this.analyzer = new RequestAnalyzer();
  }

  decide(request: AnthropicRequest, conversationId?: string): RoutingDecision {
    const analysis = this.analyzer.analyze(request);
    this.analyzer.logAnalysis(analysis, this.config.routing.debugMode);

    const decision = this.applyRoutingRules(analysis, conversationId);
    this.logDecision(decision, analysis);

    return decision;
  }

  private applyRoutingRules(
    analysis: RequestAnalysis,
    conversationId?: string,
  ): RoutingDecision {
    if (analysis.type === 'tool_result_feedback' && conversationId) {
      const previousBackend = this.sessionBackends.get(conversationId);
      if (previousBackend) {
        return {
          backend: previousBackend,
          reason: `Maintain backend for tool result feedback (previous: ${getBackendDisplayName(previousBackend)})`,
          confidence: 1.0,
          allowFallback: false,
          ruleId: 'rule_1_tool_result_continuity',
        };
      }
    }

    if (analysis.hasClaudeCodeTools) {
      if (!this.config.deepseek.enabled) {
        consola.warn('Claude Code tools detected, but DeepSeek is not configured.');
        return {
          backend: 'sider',
          reason: 'DeepSeek is required for Claude Code tools but is not available.',
          confidence: 0.2,
          allowFallback: false,
          ruleId: 'rule_2_claude_tools_fallback',
        };
      }

      return {
        backend: 'deepseek',
        reason: `Request contains Claude Code tools: ${analysis.claudeCodeToolNames.slice(0, 3).join(', ')}`,
        confidence: 1.0,
        allowFallback: false,
        ruleId: 'rule_2_claude_tools',
      };
    }

    if (analysis.hasMcpTools) {
      if (!this.config.deepseek.enabled) {
        consola.warn('MCP tools detected, but DeepSeek is not configured.');
        return {
          backend: 'sider',
          reason: 'DeepSeek is required for MCP tools but is not available.',
          confidence: 0.2,
          allowFallback: false,
          ruleId: 'rule_3_mcp_tools_fallback',
        };
      }

      return {
        backend: 'deepseek',
        reason: `Request contains MCP tools: ${analysis.mcpToolNames.slice(0, 3).join(', ')}`,
        confidence: 1.0,
        allowFallback: false,
        ruleId: 'rule_3_mcp_tools',
      };
    }

    if (analysis.hasSiderTools && !analysis.hasClaudeCodeTools && !analysis.hasMcpTools) {
      if (this.config.sider.enabled) {
        return {
          backend: 'sider',
          reason: `Request contains only Sider native tools: ${analysis.siderToolNames.join(', ')}`,
          confidence: 0.9,
          allowFallback: true,
          ruleId: 'rule_4_sider_tools',
        };
      }
    }

    if (analysis.type === 'simple_chat') {
      if (this.config.routing.preferSiderForSimpleChat && this.config.sider.enabled) {
        return {
          backend: 'sider',
          reason: 'Simple chat, prefer Sider because Anthropic model text is available there.',
          confidence: 0.8,
          allowFallback: true,
          ruleId: 'rule_5_simple_chat_prefer_sider',
        };
      }

      if (this.config.deepseek.enabled) {
        return {
          backend: 'deepseek',
          reason: 'Simple chat, Sider is not preferred or unavailable.',
          confidence: 0.7,
          allowFallback: true,
          ruleId: 'rule_5_simple_chat_deepseek',
        };
      }

      if (this.config.sider.enabled) {
        return {
          backend: 'sider',
          reason: 'Simple chat, fallback to Sider.',
          confidence: 0.6,
          allowFallback: false,
          ruleId: 'rule_5_simple_chat_fallback_sider',
        };
      }
    }

    const defaultBackend = this.config.routing.defaultBackend;
    if (defaultBackend === 'sider' && this.config.sider.enabled) {
      return {
        backend: 'sider',
        reason: 'Default backend.',
        confidence: 0.6,
        allowFallback: true,
        ruleId: 'rule_6_default_sider',
      };
    }

    if (this.config.deepseek.enabled) {
      return {
        backend: 'deepseek',
        reason: 'Default backend or Sider unavailable.',
        confidence: 0.6,
        allowFallback: false,
        ruleId: 'rule_6_default_deepseek',
      };
    }

    throw new Error('No backend available.');
  }

  recordSessionBackend(conversationId: string, backend: Backend): void {
    this.sessionBackends.set(conversationId, backend);
    consola.debug(
      `Session backend recorded: ${conversationId.substring(0, 12)}... -> ${getBackendDisplayName(backend)}`,
    );
  }

  getSessionBackend(conversationId: string): Backend | undefined {
    return this.sessionBackends.get(conversationId);
  }

  cleanupExpiredSessions(_maxAge: number = 3600000): number {
    const count = this.sessionBackends.size;
    this.sessionBackends.clear();
    return count;
  }

  private logDecision(decision: RoutingDecision, analysis: RequestAnalysis): void {
    if (!this.config.routing.debugMode) {
      consola.info(`Routing: ${getBackendDisplayName(decision.backend)} (${decision.ruleId})`);
      return;
    }

    consola.box({
      title: 'Routing Decision',
      message: `
Backend: ${getBackendDisplayName(decision.backend)}
Rule: ${decision.ruleId}
Reason: ${decision.reason}
Confidence: ${(decision.confidence * 100).toFixed(0)}%
Allow Fallback: ${decision.allowFallback ? 'Yes' : 'No'}

Context:
  Request Type: ${analysis.type}
  Tool Count: ${analysis.toolCount}
  Claude Code Tools: ${analysis.claudeCodeToolNames.join(', ') || 'none'}
  MCP Tools: ${analysis.mcpToolNames.join(', ') || 'none'}
  Sider Tools: ${analysis.siderToolNames.join(', ') || 'none'}
      `.trim(),
      style: {
        borderColor: 'green',
        borderStyle: 'rounded',
      },
    });
  }

  getStats(): {
    totalSessions: number;
    siderSessions: number;
    deepseekSessions: number;
  } {
    let siderCount = 0;
    let deepseekCount = 0;

    for (const backend of this.sessionBackends.values()) {
      if (backend === 'sider') {
        siderCount++;
      } else {
        deepseekCount++;
      }
    }

    return {
      totalSessions: this.sessionBackends.size,
      siderSessions: siderCount,
      deepseekSessions: deepseekCount,
    };
  }
}
