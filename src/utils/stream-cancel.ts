/**
 * 上游流的收口释放。
 *
 * 为什么必须 cancel 而不只是 releaseLock：读循环有很多提前退出的出口——SSE 内
 * 收到业务错误码时回调直接 throw、命中 stop_sequence、客户端断连导致 enqueue 抛错。
 * 只 releaseLock 的话上游连接还挂着、还在发数据、没人读，要等 `AbortSignal.timeout`
 * 30 秒后才断。而 Sider 是**单并发**的（同一账号同一时刻只接一个 active request），
 * 一条泄漏的流很可能正让下一个请求撞 1101。
 *
 * 收口放在读循环的 `finally` 里，一处覆盖全部出口——逐个 return 前补 cancel 的写法
 * 漏一个就是一次泄漏。正常读完（done）时调用也无害：cancel 对已关闭的流是 no-op。
 */
export async function cancelUpstreamReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // 流已关闭或已 error 时 cancel 会抛，忽略：那时上游连接本就没了。
  }
  try {
    reader.releaseLock();
  } catch {
    // cancel 之后锁通常已经不需要显式释放，重复释放不该影响调用方。
  }
}
