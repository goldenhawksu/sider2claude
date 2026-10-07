import { cancelUpstreamReader } from './stream-cancel';

export const DEFAULT_UPSTREAM_IDLE_MS = 300_000;

/** 空闲计时由真实上游字节刷新；总时长上限防止心跳流无限占用连接。 */
export function createUpstreamDeadline(idleMs: number, totalMs = 600_000) {
  const controller = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout>;
  let lastActivityAt = Date.now();
  const abort = (phase: 'idle' | 'total') =>
    controller.abort(Object.assign(
      new DOMException(`Upstream ${phase} timeout`, 'TimeoutError'),
      { timeoutPhase: phase, idleMs, totalMs, lastActivityAt },
    ));
  const touch = () => {
    if (controller.signal.aborted) return;
    lastActivityAt = Date.now();
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => abort('idle'), idleMs);
  };
  const totalTimer = setTimeout(() => abort('total'), totalMs);
  touch();
  return {
    signal: controller.signal,
    touch,
    dispose() {
      clearTimeout(idleTimer);
      clearTimeout(totalTimer);
    },
  };
}

/** 读取 JSON 或 Anthropic SSE，完整拼接工具输入后交由既有响应校验及兼容处理。 */
export async function readUpstreamResponse(
  response: Response,
  deadline: ReturnType<typeof createUpstreamDeadline>,
  onFirstChunk: () => void,
): Promise<unknown> {
  const isStream = response.headers.get('content-type')?.includes('text/event-stream');
  if (!isStream && !response.headers.get('content-type')?.includes('application/json')) {
    await response.body?.cancel();
    throw new Error('上游返回不支持的响应类型');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('上游响应没有正文');
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(deadline.signal.reason);
  deadline.signal.addEventListener('abort', onAbort, { once: true });
  if (deadline.signal.aborted) onAbort();
  const decoder = new TextDecoder();
  let buffer = '', first = true, finished = false, started = false;
  let message: Record<string, unknown> = {};
  const blocks: Record<string, unknown>[] = [];
  const inputs = new Map<number, string>();
  const closed = new Set<number>();
  const line = (value: string) => {
    if (!value.startsWith('data:')) return;
    const data = value.slice(5).trim();
    if (!data || data === '[DONE]') return;
    const event = JSON.parse(data);
    if (event.type === 'error') throw new Error(event.error?.message || '上游流返回错误');
    if (event.type === 'message_start') {
      message = { ...event.message };
      started = true;
    } else if (event.type === 'content_block_start') {
      blocks[event.index] = { ...event.content_block };
    } else if (event.type === 'content_block_delta') {
      const block = blocks[event.index];
      if (!block) throw new Error('上游内容增量缺少起始事件');
      const delta = event.delta;
      if (delta.type === 'text_delta') block.text = String(block.text ?? '') + delta.text;
      else if (delta.type === 'thinking_delta') {
        block.thinking = String(block.thinking ?? '') + delta.thinking;
      } else if (delta.type === 'signature_delta') {
        block.signature = String(block.signature ?? '') + delta.signature;
      } else if (delta.type === 'input_json_delta') {
        inputs.set(event.index, (inputs.get(event.index) ?? '') + delta.partial_json);
      } else if (delta.type === 'citations_delta') {
        block.citations = [...(block.citations as unknown[] ?? []), delta.citation];
      } else throw new Error(`上游返回不支持的增量类型：${delta.type}`);
    } else if (event.type === 'content_block_stop') {
      const block = blocks[event.index];
      if (!block) throw new Error('上游内容结束事件缺少起始事件');
      const input = inputs.get(event.index);
      if (input) block.input = JSON.parse(input);
      inputs.delete(event.index);
      closed.add(event.index);
    } else if (event.type === 'message_delta') {
      message = {
        ...message,
        ...event.delta,
        usage: { ...(message.usage as object ?? {}), ...event.usage },
      };
    } else if (event.type === 'message_stop') finished = true;
  };
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      if (value.length) {
        deadline.touch();
        if (first) {
          first = false;
          onFirstChunk();
        }
      }
      buffer += decoder.decode(value, { stream: true });
      if (isStream) {
        let end: number;
        while ((end = buffer.indexOf('\n')) !== -1) {
          line(buffer.slice(0, end).trim());
          buffer = buffer.slice(end + 1);
        }
      }
    }
    buffer += decoder.decode();
    if (!isStream) return JSON.parse(buffer);
    if (buffer.trim()) line(buffer.trim());
    if (
      !started || !finished || inputs.size || blocks.some((_block, index) => !closed.has(index))
    ) {
      throw new Error('上游流未完整结束，不能返回不完整的工具调用');
    }
    return { ...message, content: blocks };
  } finally {
    deadline.signal.removeEventListener('abort', onAbort);
    await cancelUpstreamReader(reader);
  }
}
