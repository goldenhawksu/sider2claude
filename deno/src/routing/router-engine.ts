/**
 * 后端能力路由引擎。
 *
 * Sider 是 Claude 模型对话的首选来源；DeepSeek 作为 Anthropic 兼容后端，
 * 用来补齐 Sider 当前无法可靠提供的工具调用、MCP 工具等能力。
 */

import type { AnthropicRequest } from '../types/anthropic.ts';
import type { Backend, BackendConfig } from '../config/backends.ts';
import { getBackendDisplayName } from '../config/backends.ts';
import type { RequestAnalysis } from '../utils/request-analyzer.ts';
import { RequestAnalyzer } from '../utils/request-analyzer.ts';

export interface RoutingDecision {
  backend: Backend;
  reason: string;
  confidence: number;
  allowFallback: boolean;
  ruleId: string;
}

/**
 * 会话后端记忆的存活时间与容量上限。
 * 工具回合的连续性只在一次对话期间有意义，长期驻留既无用也会让实例无限累积条目。
 */
const SESSION_BACKEND_TTL_MS = 60 * 60_000;
const MAX_SESSION_BACKEND_ENTRIES = 500;

export class RouterEngine {
  private config: BackendConfig;
  private analyzer: RequestAnalyzer;
  private sessionBackends = new Map<string, { backend: Backend; updatedAt: number }>();

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
      const previousBackend = this.getSessionBackend(conversationId);

      // Sider 未被证明支持 Anthropic `tool_use`。本轮若带了需要 DeepSeek 承接的工具，
      // 就不能仅因为"延续上一回合"而回到 Sider：没有显式 X-Conversation-ID 的请求
      // 共享 `continuous-conversation` 这一个槽位，上一回合很可能是另一段纯对话。
      const needsToolCapableBackend = analysis.hasClaudeCodeTools || analysis.hasMcpTools;
      const siderCannotServe = previousBackend === 'sider' && needsToolCapableBackend;

      if (previousBackend && !siderCannotServe) {
        return {
          backend: previousBackend,
          reason: `Maintain backend for tool result feedback (previous: ${getBackendDisplayName(previousBackend)})`,
          confidence: 1.0,
          allowFallback: false,
          ruleId: 'rule_1_tool_result_continuity',
        };
      }

      if (siderCannotServe) {
        console.warn('Skipping tool result continuity: Sider cannot serve tool_use requests.', {
          conversationId: conversationId.substring(0, 12),
          claudeCodeTools: analysis.claudeCodeToolNames.slice(0, 3),
          mcpTools: analysis.mcpToolNames.slice(0, 3),
        });
      }
    }

    if (analysis.hasClaudeCodeTools) {
      if (!this.config.deepseek.enabled) {
        console.warn('Claude Code tools detected, but DeepSeek is not configured.');
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
        console.warn('MCP tools detected, but DeepSeek is not configured.');
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

    if (analysis.type === 'simple_chat' && analysis.hasLongFormGenerationIntent) {
      if (this.config.deepseek.enabled) {
        return {
          backend: 'deepseek',
          reason: `Long-form generation is better handled by DeepSeek: ${analysis.longFormSignals.join(', ')}`,
          confidence: 0.85,
          allowFallback: true,
          ruleId: 'rule_5_long_form_generation',
        };
      }

      if (this.config.sider.enabled) {
        return {
          backend: 'sider',
          reason: 'Long-form generation detected, but DeepSeek is not configured.',
          confidence: 0.45,
          allowFallback: false,
          ruleId: 'rule_5_long_form_generation_fallback_sider',
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
    // 先删后插：让 Map 的插入顺序反映最近使用，超量时可直接淘汰最老的条目。
    this.sessionBackends.delete(conversationId);
    this.sessionBackends.set(conversationId, { backend, updatedAt: Date.now() });
    this.evictOverflowSessions();

    console.log(
      `Session backend recorded: ${conversationId.substring(0, 12)}... -> ${getBackendDisplayName(backend)}`,
    );
  }

  /** 读取会话后端；超过 TTL 的记录视为不存在并顺手清除。 */
  getSessionBackend(conversationId: string): Backend | undefined {
    const entry = this.sessionBackends.get(conversationId);
    if (!entry) {
      return undefined;
    }

    if (Date.now() - entry.updatedAt > SESSION_BACKEND_TTL_MS) {
      this.sessionBackends.delete(conversationId);
      return undefined;
    }

    return entry.backend;
  }

  /** 清理过期的会话后端记录，返回清理条数。 */
  cleanupExpiredSessions(maxAge: number = SESSION_BACKEND_TTL_MS): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [conversationId, entry] of this.sessionBackends.entries()) {
      if (now - entry.updatedAt > maxAge) {
        this.sessionBackends.delete(conversationId);
        cleaned += 1;
      }
    }

    return cleaned;
  }

  private evictOverflowSessions(): void {
    while (this.sessionBackends.size > MAX_SESSION_BACKEND_ENTRIES) {
      const oldest = this.sessionBackends.keys().next().value;
      if (!oldest) {
        return;
      }
      this.sessionBackends.delete(oldest);
    }
  }

  private logDecision(decision: RoutingDecision, analysis: RequestAnalysis): void {
    if (!this.config.routing.debugMode) {
      console.log(`Routing: ${getBackendDisplayName(decision.backend)} (${decision.ruleId})`);
      return;
    }

    console.log('Routing decision:', {
      backend: getBackendDisplayName(decision.backend),
      rule: decision.ruleId,
      reason: decision.reason,
      confidence: decision.confidence,
      allowFallback: decision.allowFallback,
      requestType: analysis.type,
      toolCount: analysis.toolCount,
      claudeCodeTools: analysis.claudeCodeToolNames,
      mcpTools: analysis.mcpToolNames,
      siderTools: analysis.siderToolNames,
      longFormSignals: analysis.longFormSignals,
    });
  }

  getStats(): {
    totalSessions: number;
    siderSessions: number;
    deepseekSessions: number;
  } {
    let siderCount = 0;
    let deepseekCount = 0;

    for (const entry of this.sessionBackends.values()) {
      if (entry.backend === 'sider') {
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
