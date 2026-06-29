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
    reader.releaseLock();
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
} {
  const result: SiderParsedResponse = {
    reasoningParts: [],
    textParts: [],
    toolResults: [],
    model: '',
  };

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
  };

  return { callbacks, result };
}
