import { ApiClient } from './integration/harness.ts';

Deno.test('主控续传客户端：只重试明确的登记进度并保持请求体，供应商限流仍暴露', async () => {
  const original = globalThis.fetch;
  const client = new ApiClient({
    baseUrl: 'https://fixture.invalid',
    authToken: 'test',
    timeoutMs: 1000,
    liveModel: 'claude-sonnet-5.5',
    claudeCodeSonnet: 'claude-sonnet-5.5',
    claudeCodeOpus: 'claude-opus-5.5',
    reportDir: 'unused',
  });
  const bodies: unknown[] = [];
  let count = 0;
  try {
    globalThis.fetch = ((_url, init) => {
      bodies.push(init?.body);
      count++;
      return Promise.resolve(
        new Response(
          JSON.stringify(
            count < 3
              ? {
                type: 'error',
                error: {
                  type: 'rate_limit_error',
                  message: '上下文登记进度2/18，检查点已保存，请继续',
                },
              }
              : { content: [{ type: 'text', text: '已完成' }] },
          ),
          {
            status: count < 3 ? 429 : 200,
            headers: { 'x-sider-controller': 'true', 'retry-after': '0' },
          },
        ),
      );
    }) as typeof fetch;
    const response = await client.post('/v1/messages', {
      messages: [{ role: 'user', content: '继续P08' }],
    });
    if (response.status !== 200 || count !== 3 || new Set(bodies).size !== 1) {
      throw new Error('登记续传未保持同一请求');
    }
    count = 0;
    globalThis.fetch = (() => {
      count++;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'rate_limit_error', message: 'Sider模型额度仍在冷却，主控任务保留' },
          }),
          { status: 429, headers: { 'x-sider-controller': 'true', 'retry-after': '0' } },
        ),
      );
    }) as typeof fetch;
    const limited = await client.post('/v1/messages', {});
    if (limited.status !== 429 || count !== 1) throw new Error('不能把供应商限流隐藏为登记续传');
  } finally {
    globalThis.fetch = original;
  }
});
