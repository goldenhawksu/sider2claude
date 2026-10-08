import { createUpstreamDeadline, DEFAULT_UPSTREAM_IDLE_MS } from './upstream-response.js';
import { cancelUpstreamReader } from './stream-cancel.js';

/** 全程计时：仅上游字节刷新空闲期限，结束或取消后释放计时器和reader。 */
export async function fetchSiderResponse(
  url: string,
  init: RequestInit,
  idleMs = DEFAULT_UPSTREAM_IDLE_MS,
  totalMs = 600_000,
): Promise<Response> {
  const deadline = createUpstreamDeadline(idleMs, totalMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const signal = init.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal;
    const response = await fetch(url, { ...init, signal });
    reader = response.body?.getReader();
    if (!reader) {
      deadline.dispose();
      return response;
    }
    const source = reader;
    let rejectAbort!: (reason: unknown) => void;
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    // 取消发生在拉取之间时也不产生未处理拒绝。
    void aborted.catch(() => {});
    const onAbort = () => rejectAbort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    const cleanup = async () => {
      signal.removeEventListener('abort', onAbort);
      deadline.dispose();
      await cancelUpstreamReader(source);
    };
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await Promise.race([source.read(), aborted]);
          if (done) {
            await cleanup();
            controller.close();
          } else {
            if (value.byteLength) deadline.touch();
            controller.enqueue(value);
          }
        } catch (error) {
          await cleanup();
          controller.error(error);
        }
      },
      cancel: cleanup,
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    deadline.dispose();
    if (reader) await cancelUpstreamReader(reader);
    throw error;
  }
}
