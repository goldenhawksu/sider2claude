function assertEquals<T>(actual: T, expected: T, what = '值') {
  if (actual !== expected) {
    throw new Error(`${what}：期望 ${String(expected)}，实际 ${String(actual)}`);
  }
}

function assertIncludes(values: string, expected: string, what: string) {
  if (!values.toLowerCase().split(',').map((value) => value.trim()).includes(expected)) {
    throw new Error(`${what}：${values}`);
  }
}

async function withAuthToken(fn: () => Promise<void>) {
  const previous = Deno.env.get('AUTH_TOKEN');
  Deno.env.set('AUTH_TOKEN', 'main-security-token');
  try {
    await fn();
  } finally {
    if (previous === undefined) Deno.env.delete('AUTH_TOKEN');
    else Deno.env.set('AUTH_TOKEN', previous);
  }
}

let serverPromise: Promise<(typeof import('../main.ts'))['default']> | undefined;
async function loadServer() {
  if (!serverPromise) {
    const previousSiderToken = Deno.env.get('SIDER_AUTH_TOKEN');
    Deno.env.set('SIDER_AUTH_TOKEN', 'main-security-sider-token');
    serverPromise = import(`../main.ts?test=${crypto.randomUUID()}`).then((module) =>
      module.default
    );
    await serverPromise;
    if (previousSiderToken === undefined) Deno.env.delete('SIDER_AUTH_TOKEN');
    else Deno.env.set('SIDER_AUTH_TOKEN', previousSiderToken);
  }
  return await serverPromise;
}

async function request(path: string, init?: RequestInit) {
  const server = await loadServer();
  return server.fetch(new Request(`http://localhost${path}`, init));
}

Deno.test('主入口：CORS允许Anthropic浏览器客户端所需头部', async () => {
  const response = await request('/v1/messages', {
    method: 'OPTIONS',
    headers: {
      origin: 'https://client.example',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type,x-api-key,anthropic-version',
    },
  });
  assertEquals(response.status, 204, '预检状态');
  const allowed = response.headers.get('access-control-allow-headers') ?? '';
  assertIncludes(allowed, 'content-type', '允许 content-type');
  assertIncludes(allowed, 'x-api-key', '允许 x-api-key');
  assertIncludes(allowed, 'anthropic-version', '允许 anthropic-version');
});

Deno.test('主入口：统一返回安全与缓存控制响应头', async () => {
  const response = await request('/health');
  assertEquals(response.status, 200);
  assertEquals(response.headers.get('x-content-type-options'), 'nosniff');
  assertEquals(response.headers.get('x-frame-options'), 'DENY');
  assertEquals(response.headers.get('referrer-policy'), 'no-referrer');
  assertEquals(response.headers.get('cache-control'), 'no-store');
});

Deno.test('主入口：策略写入与原始遥测必须认证', async () => {
  await withAuthToken(async () => {
    const missing = await request('/stats/strategy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ strategy: 'pro' }),
    });
    assertEquals(missing.status, 401, '策略写入缺凭证');

    const invalid = await request('/stats/strategy', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'wrong-token' },
      body: JSON.stringify({ strategy: 'pro' }),
    });
    assertEquals(invalid.status, 401, '策略写入错误凭证');

    const validButNoMutation = await request('/stats/strategy', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'main-security-token' },
      body: JSON.stringify({ strategy: '__invalid__' }),
    });
    assertEquals(validButNoMutation.status, 400, '合法凭证进入参数校验');

    assertEquals((await request('/stats/telemetry.json')).status, 401, '遥测缺凭证');
    const telemetry = await request('/stats/telemetry.json', {
      headers: { 'x-api-key': 'main-security-token' },
    });
    assertEquals(telemetry.status, 200, '遥测合法凭证');
    const body = await telemetry.json();
    assertEquals(Array.isArray(body.records), true, '遥测记录数组');
  });
});

Deno.test('主入口：畸形messages JSON返回400而不是500', async () => {
  await withAuthToken(async () => {
    const response = await request('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'main-security-token' },
      body: '{ invalid json',
    });
    assertEquals(response.status, 400);
    const body = await response.json();
    assertEquals(body.type, 'error');
    assertEquals(body.error?.type, 'invalid_request_error');
  });
});
