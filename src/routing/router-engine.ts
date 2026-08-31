/**
 * 后端能力路由引擎。
 *
 * Sider 是 Claude 模型对话的首选来源；DeepSeek 作为 Anthropic 兼容后端，
 * 用来补齐 Sider 当前无法可靠提供的工具调用、MCP 工具等能力。
 */

import type { AnthropicRequest } from '../types/anthropic';
import type { Backend, BackendConfig } from '../config/backends';
import {
  getBackendDisplayName,
  siderHandlesTools,
  usesAdaptiveThrottle,
} from '../config/backends';
import type { RequestAnalysis } from '../utils/request-analyzer';
import { RequestAnalyzer } from '../utils/request-analyzer';
import { isSiderCooling, siderCooldownRemainingMs } from '../utils/sider-availability';
import { canUseSider, consumeSiderSlot } from '../utils/sider-throttle';
import { getEnv } from '../utils/env';
import { consola } from 'consola';

export interface RoutingDecision {
  backend: Backend;
  reason: string;
  confidence: number;
  allowFallback: boolean;
  ruleId: string;
}

/**
 * 投给 Sider 的请求体量上限（字符）。
 *
 * 实测：32,000 字符通过，44,000 字符被 `code 603: Too many words in the query`
 * 硬拒。取 30,000 留余量。超限的请求投过去必然失败，白费一个往返 —— 与其等
 * fallback 兜底，不如一开始就别选 Sider。
 */
const SIDER_MAX_INPUT_CHARS = Number(getEnv('SIDER_MAX_INPUT_CHARS') ?? '') || 30_000;

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

    const decision = this.applyRoutingRules(analysis, request.model, conversationId);

    // 决策定下来之后才扣令牌：applyRoutingRules 开头的可用性判断必须是只读的，
    // 因为那一刻还不知道工具规则会不会把决策覆盖成 DeepSeek。若检查即扣费，
    // 每个走 DeepSeek 的工具请求都会白扣一次 Sider 额度。
    if (decision.backend === 'sider' && usesAdaptiveThrottle(this.config.routing.siderStrategy)) {
      consumeSiderSlot(request.model);
    }

    this.logDecision(decision, analysis);

    return decision;
  }

  /**
   * Sider 现在能不能接这个请求。
   *
   * 只管「要不要**主动选**它」，不影响既有 fallback —— Sider 真失败时该兜底还是兜底。
   *
   * 两套策略，由 SIDER_STRATEGY 选择：
   * - `conservative`（默认）：静态阈值 + 固定冷却熔断。三个否决项都来自实测——
   *   没配置无从谈起；配额熔断中撞上去只会拿到 1135 再兜底；体量超限会被 603 硬拒。
   * - `pro` / `max`：熔断/频次/体量三道门全部交给自适应限流器，阈值由运行中的
   *   603/1135 反馈学习出来，而不是预设。见 utils/sider-throttle.ts。
   */
  private siderUsable(
    analysis: RequestAnalysis,
    model: string,
  ): { ok: true } | { ok: false; why: string } {
    if (!this.config.sider.enabled) {
      return { ok: false, why: 'Sider is not configured' };
    }
    if (usesAdaptiveThrottle(this.config.routing.siderStrategy)) {
      return canUseSider(model, analysis.inputCharCount);
    }
    if (isSiderCooling(model)) {
      const seconds = Math.ceil(siderCooldownRemainingMs(model) / 1000);
      return { ok: false, why: `Sider quota cooling down for ${model} (${seconds}s left)` };
    }
    if (analysis.inputCharCount > SIDER_MAX_INPUT_CHARS) {
      return {
        ok: false,
        why: `Input ${analysis.inputCharCount} chars exceeds Sider limit ${SIDER_MAX_INPUT_CHARS}`,
      };
    }
    return { ok: true };
  }

  /**
   * Max 策略：工具请求也先投 Sider。
   *
   * Sider 原生不提供 Anthropic `tool_use`，靠注入文本工具契约实现（probe 实测
   * sonnet-5 在单轮、带引号命令、大 schema 等场景均 5/5）。因此这条规则**必须**
   * 允许 fallback：还原不出调用、或上游报错时要能立刻转 DeepSeek 重做，
   * 否则 Claude Code 会拿到一段纯文本、判定回合结束、agent 循环停住。
   *
   * 不在这里排除 opus 档：限流器会从 1135 反馈里学出该档额度撑不住，
   * 几次之后自动熔断转 DeepSeek，比在路由里写死一个模型名单更准。
   */
  private siderToolsDecision(
    siderReady: { ok: true } | { ok: false; why: string },
    kind: string,
    analysis: RequestAnalysis,
  ): RoutingDecision | undefined {
    if (!siderHandlesTools(this.config.routing.siderStrategy) || !siderReady.ok) {
      return undefined;
    }

    const names = [...analysis.claudeCodeToolNames, ...analysis.mcpToolNames].slice(0, 3);
    return {
      backend: 'sider',
      reason: `Max strategy: try Sider for ${kind} tools via text contract (${names.join(', ')})`,
      confidence: 0.7,
      allowFallback: true,
      ruleId: 'rule_2_tools_sider_max',
    };
  }

  private applyRoutingRules(
    analysis: RequestAnalysis,
    model: string,
    conversationId?: string,
  ): RoutingDecision {
    const siderReady = this.siderUsable(analysis, model);

    if (analysis.type === 'tool_result_feedback' && conversationId) {
      const previousBackend = this.getSessionBackend(conversationId);

      // Sider 未被证明支持 Anthropic `tool_use`。本轮若带了需要 DeepSeek 承接的工具，
      // 就不能仅因为"延续上一回合"而回到 Sider：没有显式 X-Conversation-ID 的请求
      // 共享 `continuous-conversation` 这一个槽位，上一回合很可能是另一段纯对话。
      //
      // Max 策略例外：那时 Sider 通过文本契约本来就能接工具，守卫的前提（Sider 接不了）
      // 不再成立，继续拦着只会把能留在 Sider 的工具续轮白白推给 DeepSeek。
      const needsToolCapableBackend = (analysis.hasClaudeCodeTools || analysis.hasMcpTools) &&
        !siderHandlesTools(this.config.routing.siderStrategy);
      const siderCannotServe = previousBackend === 'sider' &&
        (needsToolCapableBackend || !siderReady.ok);

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
        consola.warn('Skipping tool result continuity: Sider cannot serve this turn.', {
          conversationId: conversationId.substring(0, 12),
          claudeCodeTools: analysis.claudeCodeToolNames.slice(0, 3),
          mcpTools: analysis.mcpToolNames.slice(0, 3),
          siderReady: siderReady.ok ? 'yes' : siderReady.why,
        });
      }
    }

    if (analysis.hasClaudeCodeTools) {
      const siderTools = this.siderToolsDecision(siderReady, 'Claude Code', analysis);
      if (siderTools) return siderTools;

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
      const siderTools = this.siderToolsDecision(siderReady, 'MCP', analysis);
      if (siderTools) return siderTools;

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

    // 视觉输入必须留在看得见图片的后端。
    //
    // DeepSeek 端（实为 glm-5.3-flash）是 VLM，原生吃图文混排；Sider 通道走的是另一
    // 套 multi_content 协议，实测把图片喂过去模型会回答「我没有收到图片」——HTTP 200、
    // 有回答、只是压根没看见图。这类**静默失败**比报错更糟，调用方无从察觉视觉没生效，
    // 所以这条规则刻意 `allowFallback: false`：fallback 回 Sider 等于把图再丢一次，
    // 宁可把错误暴露出来。
    //
    // 位置在 Sider 原生工具规则之前：图文请求即便带了 web_search，也要先保住看图能力。
    // DeepSeek 未配置时不拦截，交给后续规则——那时丢图但仍可用，比直接不可用好。
    if (analysis.hasImageContent && this.config.deepseek.enabled) {
      return {
        backend: 'deepseek',
        reason: 'Request contains image input; the Sider channel would drop it silently',
        confidence: 0.95,
        allowFallback: false,
        ruleId: 'rule_4_vision_input',
      };
    }

    if (analysis.hasSiderTools && !analysis.hasClaudeCodeTools && !analysis.hasMcpTools) {
      if (siderReady.ok) {
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
      if (this.config.routing.preferSiderForSimpleChat && siderReady.ok) {
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
    if (defaultBackend === 'sider' && siderReady.ok) {
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

    consola.debug(
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
  Long-form Signals: ${analysis.longFormSignals.join(', ') || 'none'}
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
