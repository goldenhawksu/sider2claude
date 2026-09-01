/**
 * Sider SSE 流式行读取器。
 *
 * 把 Sider 的 SSE 响应按事件类型分发给回调，供两种消费方式复用：
 * - 累积模式：createAccumulatorCallbacks() 收集成 SiderParsedResponse（兼容原 chat()）。
 * - 流式模式：messages-hybrid 的真流式状态机实时消费回调。
 */

import type {
  SiderCreditInfo,
  SiderIgnoredEvent,
  SiderMessageStart,
  SiderParsedResponse,
  SiderReasoningContent,
  SiderSSEResponse,
  SiderTextContent,
  SiderToolCallProgress,
  SiderToolCallResult,
  SiderToolCallStart,
} from '../types/index.ts';
import { getOrCreateContinuousSession, saveSiderSession } from './sider-session-manager.ts';
import { cancelUpstreamReader } from './stream-cancel.ts';

/**
 * Sider 在 SSE 内用 `code !== 0` 表达业务失败（如 1135 用量超限），HTTP 状态仍是 200。
 * 这类失败必须显式表达，否则调用方只会收到一个空回复，既无法 fallback 也无法诊断。
 */
export class SiderUpstreamError extends Error {
  constructor(
    message: string,
    public siderCode: number,
    public statusCode: number,
    /**
     * 上游原始 msg（不含本地拼的前缀）。1135 的恢复时长就写在这里面，
     * 单独留一份是为了让下游解析时不必先剥前缀。
     */
    public upstreamMessage = '',
    /** 从 `upstreamMessage` 解析出的上游建议重试间隔（毫秒）；解析不出为 undefined。 */
    public retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'SiderUpstreamError';
  }
}

/**
 * 从上游消息里解析「还要等多久」。
 *
 * 1135 的消息实测长这样，恢复时刻是上游**主动告诉我们的事实**：
 *   You've reached the current usage limit. ... Please try again after 117 minutes.
 * 实测跨度极大（1 / 117 / 261 / 272 分钟），任何硬编码的冷却值都会在两个方向同时
 * 出错：说 1 分钟时白闲置一小时的额度，说 272 分钟时每分钟去撞一次墙。
 *
 * 解析不出返回 undefined，由调用方回退到自己的保守默认值——上游随时可能改文案，
 * 这个函数失效时整套熔断要能退回原来的行为，而不是失去冷却。
 */
const RETRY_AFTER_PATTERN =
  /after\s+(\d+(?:\.\d+)?)\s*(hours?|hrs?|minutes?|mins?|seconds?|secs?)/i;

export function parseSiderRetryAfterMs(msg: string): number | undefined {
  const match = RETRY_AFTER_PATTERN.exec(msg);
  if (!match) {
    return undefined;
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  const unit = (match[2] ?? '').toLowerCase();
  const factor = unit.startsWith('h') ? 3_600_000 : unit.startsWith('m') ? 60_000 : 1_000;
  return Math.round(value * factor);
}

/**
 * 由 Sider 业务错误码构造错误。消息格式与状态码映射只在这里定义一次：
 * - 1135 用量超限 -> 429（可重试，且带上游给的时长）；
 * - 603 单请求体量超限 -> 413。这是**调用方的输入问题**，不是上游故障；
 *   报 502 会让客户端以为是服务端抖动而去重试，而重试同一个超长载荷必然再失败；
 * - 其余按上游故障 -> 502。
 */
export function siderUpstreamError(code: number, msg: string): SiderUpstreamError {
  return new SiderUpstreamError(
    `Sider upstream error ${code}: ${msg}`,
    code,
    code === 1135 ? 429 : code === 603 ? 413 : 502,
    msg,
    code === 1135 ? parseSiderRetryAfterMs(msg) : undefined,
  );
}

export interface SiderStreamCallbacks {
  onMessageStart?: (data: SiderMessageStart) => void;
  onReasoningContent?: (data: SiderReasoningContent) => void;
  onText?: (data: SiderTextContent) => void;
  onToolCallStart?: (data: SiderToolCallStart) => void;
  onToolCallProgress?: (data: SiderToolCallProgress) => void;
  onToolCallResult?: (data: SiderToolCallResult) => void;
  onCreditInfo?: (data: SiderCreditInfo) => void;
  onIgnoredEvent?: (data: SiderIgnoredEvent) => void;
  onWarning?: (code: number, msg: string) => void;
}

/**
 * 屏蔽敏感 ID，仅保留前缀用于日志。
 */
export function maskId(id?: string): string {
  if (!id) {
    return 'new';
  }
  return id.length > 12 ? `${id.substring(0, 12)}...` : id;
}

/**
 * 读取并分发 Sider SSE 流。回调在解析到对应事件时同步触发；
 * 流结束（reader done）后函数 resolve，是否发送结束事件由调用方决定。
 */
export async function streamSiderSSE(
  response: Response,
  callbacks: SiderStreamCallbacks,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('No response body');
  }

  const decoder = new TextDecoder();
  try {
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // 保留最后一个不完整的行

      for (const line of lines) {
        dispatchSSELine(line.trim(), callbacks);
      }
    }

    if (buffer.trim()) {
      dispatchSSELine(buffer.trim(), callbacks);
    }
  } finally {
    // onWarning 回调（1135 等业务错误码）会同步 throw 穿出这个循环，是最高频的
    // 提前退出路径。必须 cancel 上游，否则连接会挂到超时才断。
    await cancelUpstreamReader(reader);
  }
}

function dispatchSSELine(line: string, callbacks: SiderStreamCallbacks): void {
  // 跳过空行和注释
  if (!line || line.startsWith(':')) {
    return;
  }
  if (!line.startsWith('data:')) {
    return;
  }

  const dataStr = line.substring(5).trim();
  if (dataStr === '[DONE]') {
    return;
  }

  let data: SiderSSEResponse;
  try {
    data = JSON.parse(dataStr) as SiderSSEResponse;
  } catch (error) {
    console.warn('Failed to parse Sider SSE data:', {
      dataLength: dataStr.length,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  if (data.code !== 0) {
    console.warn('Sider API warning:', { code: data.code, msg: data.msg });
    callbacks.onWarning?.(data.code, data.msg);
    return;
  }

  switch (data.data.type) {
    case 'credit_info':
      callbacks.onCreditInfo?.(data.data);
      break;

    case 'pulse':
    case 'tag_stream':
      callbacks.onIgnoredEvent?.(data.data);
      break;

    case 'message_start':
      callbacks.onMessageStart?.(data.data);
      break;

    case 'reasoning_content':
      callbacks.onReasoningContent?.(data.data);
      break;

    case 'text':
      callbacks.onText?.(data.data);
      break;

    case 'tool_call_start':
      callbacks.onToolCallStart?.(data.data);
      break;

    case 'tool_call_progress':
      callbacks.onToolCallProgress?.(data.data);
      break;

    case 'tool_call_result':
      callbacks.onToolCallResult?.(data.data);
      break;

    default:
      console.debug('Unknown Sider SSE event type:', {
        type: (data.data as { type?: string }).type || 'unknown',
      });
  }
}

/**
 * 把 message_start 事件持久化到会话管理器。
 * 累积模式与流式状态机共用，保证两条路径会话行为一致。
 */
export function persistSessionFromMessageStart(data: SiderMessageStart): void {
  const { cid, user_message_id, assistant_message_id } = data.message_start;
  const model = data.model;

  saveSiderSession(cid, user_message_id, assistant_message_id, model);

  // 连续对话会话也同步更新连续会话状态
  if (cid === 'continuous-conversation' || cid === '') {
    const continuousSession = getOrCreateContinuousSession();
    continuousSession.userMessageId = user_message_id;
    continuousSession.assistantMessageId = assistant_message_id;
    continuousSession.model = model;
    continuousSession.lastActivity = Date.now();
    continuousSession.messageCount += 1;
  }

  console.log('Real Sider session captured:', {
    cid: maskId(cid),
    userMsgId: maskId(user_message_id),
    assistantMsgId: maskId(assistant_message_id),
    model,
  });
}

/**
 * 累积模式回调：把流式事件收集为 SiderParsedResponse，兼容原 chat() 行为。
 */
export function createAccumulatorCallbacks(): {
  callbacks: SiderStreamCallbacks;
  result: SiderParsedResponse;
  upstream: { error?: SiderUpstreamError };
} {
  const result: SiderParsedResponse = {
    reasoningParts: [],
    textParts: [],
    toolResults: [],
    model: '',
  };
  const upstream: { error?: SiderUpstreamError } = {};

  const ensureTool = (toolId: string, toolName: string) => {
    if (!result.toolResults) {
      result.toolResults = [];
    }
    let tool = result.toolResults.find((t) => t.toolId === toolId);
    if (!tool) {
      tool = { toolName, toolId, result: null, status: 'start' };
      result.toolResults.push(tool);
    }
    return tool;
  };

  const callbacks: SiderStreamCallbacks = {
    onMessageStart(data) {
      result.conversationId = data.message_start.cid;
      result.messageIds = {
        user: data.message_start.user_message_id,
        assistant: data.message_start.assistant_message_id,
      };
      result.model = data.model;
      persistSessionFromMessageStart(data);
    },
    onReasoningContent(data) {
      if (data.reasoning_content?.text) {
        result.reasoningParts.push(data.reasoning_content.text);
      }
      result.model = data.model;
    },
    onText(data) {
      if (data.text) {
        result.textParts.push(data.text);
      }
      result.model = data.model;
    },
    onToolCallStart(data) {
      const tool = ensureTool(data.tool_call.id, data.tool_call.name);
      tool.status = 'start';
      result.model = data.model;
      console.log('Tool call started:', {
        toolId: maskId(data.tool_call.id),
        toolName: data.tool_call.name,
      });
    },
    onToolCallProgress(data) {
      const tool = ensureTool(data.tool_call.id, data.tool_call.name);
      tool.status = 'processing';
      if (data.tool_call.progress) {
        tool.result = { ...tool.result, progress: data.tool_call.progress };
      }
      result.model = data.model;
    },
    onToolCallResult(data) {
      const tool = ensureTool(data.tool_call.id, data.tool_call.name);
      tool.status = 'finish';
      tool.result = data.tool_call.result;
      if (data.tool_call.error) {
        tool.error = data.tool_call.error;
        console.warn('Tool call failed:', {
          toolName: data.tool_call.name,
          error: data.tool_call.error,
        });
      } else {
        console.log('Tool call completed:', {
          toolId: maskId(data.tool_call.id),
          toolName: data.tool_call.name,
        });
      }
      result.model = data.model;
    },
    onWarning(code, msg) {
      // 保留首个错误：后续事件可能继续到达，但首个错误最接近失败原因。
      upstream.error ??= siderUpstreamError(code, msg);
    },
  };

  return { callbacks, result, upstream };
}
