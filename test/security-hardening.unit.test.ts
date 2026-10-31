/**
 * Bun 侧安全加固回归，与 deno/test/security-hardening.test.ts 对应。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { requireAdmin, requireAuth, siderTokenFor, timingSafeEqual } from '../src/middleware/auth';
import { requireStatsAuth, statsLogin } from '../src/middleware/stats-auth';
import { normalizeTextualToolUseBlocks } from '../src/utils/textual-tool-use';
import { ControllerMemoryStore } from '../src/utils/controller-memory-store';
import { withControllerLease } from '../src/utils/sider-controller';
import type { SiderAccount } from '../src/utils/sider-accounts';
import { getSiderSession, saveSiderSession } from '../src/utils/sider-session-manager';

const KEYS = [
  'AUTH_TOKEN',
  'ADMIN_TOKEN',
  'STATS_TOKEN',
  'STATS_PUBLIC',
  'ALLOW_OPEN_AUTH',
  'ALLOW_DUMMY_TOKEN',
  'SIDER_TOKEN_PASSTHROUGH',
];
const saved = new Map(KEYS.map((key) => [key, process.env[key]]));

function setEnv(vars: Record<string, string | undefined>) {
  for (const key of KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value !== undefined) process.env[key] = value;
  }
}

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function app() {
  const hono = new Hono();
  hono.use('/api/*', requireAuth);
  hono.get('/api/x', (c) => c.json({ ok: true }));
  hono.post('/admin', requireAdmin, (c) => c.json({ ok: true }));
  hono.post('/stats/login', statsLogin);
  hono.get('/stats.json', requireStatsAuth, (c) => c.json({ ok: true }));
  return hono;
}

describe('Bun 鉴权', () => {
  test('未配置 AUTH_TOKEN 默认 503，显式开放模式才放行', async () => {
    setEnv({});
    expect((await app().request('/api/x', { headers: { 'x-api-key': 'long-enough-token' } })).status)
      .toBe(503);
    setEnv({ ALLOW_OPEN_AUTH: 'true' });
    expect((await app().request('/api/x', { headers: { 'x-api-key': 'long-enough-token' } })).status)
      .toBe(200);
  });

  test('ADMIN_TOKEN 与客户端凭证分离', async () => {
    setEnv({ AUTH_TOKEN: 'client-token', ADMIN_TOKEN: 'admin-token' });
    const post = (key: string) =>
      app().request('/admin', { method: 'POST', headers: { 'x-api-key': key } });
    expect((await post('client-token')).status).toBe(401);
    expect((await post('admin-token')).status).toBe(200);
  });

  test('常量时间比较与 Sider 透传开关', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
    setEnv({});
    expect(siderTokenFor('', 'client')).toBe('');
    setEnv({ SIDER_TOKEN_PASSTHROUGH: 'true' });
    expect(siderTokenFor('', 'client')).toBe('client');
  });
});

describe('Bun 看板鉴权', () => {
  test('无凭证 401，看板凭证 200，登录 cookie 可用', async () => {
    setEnv({ AUTH_TOKEN: 'client-token', STATS_TOKEN: 'stats-token' });
    const hono = app();
    expect((await hono.request('/stats.json')).status).toBe(401);
    expect((await hono.request('/stats.json', { headers: { 'x-api-key': 'stats-token' } })).status)
      .toBe(200);
    const login = await hono.request('/stats/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'stats-token' }),
    });
    expect(login.status).toBe(200);
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    expect(cookie).not.toContain('stats-token');
    expect((await hono.request('/stats.json', { headers: { cookie } })).status).toBe(200);
  });

  test('STATS_PUBLIC=true 恢复公开', async () => {
    setEnv({ STATS_PUBLIC: 'true' });
    expect((await app().request('/stats.json')).status).toBe(200);
  });
});

describe('Bun 主入口', () => {
  test('根路径不含用量，CORS 放行 x-api-key，未知路由不暴露测试路由', async () => {
    setEnv({ AUTH_TOKEN: 'client-token' });
    const previousSider = process.env.SIDER_AUTH_TOKEN;
    process.env.SIDER_AUTH_TOKEN ??= 'bun-security-test-sider';
    const { default: server } = await import('../src/main');
    if (previousSider === undefined) delete process.env.SIDER_AUTH_TOKEN;
    const root = await (await server.fetch(new Request('http://localhost/'))).json() as Record<
      string,
      unknown
    >;
    expect('usage' in root).toBe(false);
    const preflight = await server.fetch(
      new Request('http://localhost/v1/messages', {
        method: 'OPTIONS',
        headers: {
          origin: 'https://client.example',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type,x-api-key',
        },
      }),
    );
    expect((preflight.headers.get('access-control-allow-headers') ?? '').toLowerCase())
      .toContain('x-api-key');
    expect((await server.fetch(new Request('http://localhost/api/test'))).status).toBe(404);
    expect((await server.fetch(new Request('http://localhost/stats.json'))).status).toBe(401);
  });
});

describe('Bun 文本工具与主控', () => {
  test('未声明的工具不还原', () => {
    const result = normalizeTextualToolUseBlocks(
      [{ type: 'text', text: '[tool_use:Bash] id=t1 input={"command":"ls"}' }],
      new Set(),
      undefined,
      new Set(['Read']),
    );
    expect(result.toolUseCount).toBe(0);
    expect(result.undeclaredCount).toBe(1);
  });

  test('租约等待可被中断，释放失败不覆盖结果', async () => {
    const account: SiderAccount = { id: 'acct', token: 't', primary: true };
    const store = new ControllerMemoryStore();
    let release!: () => void;
    const holding = withControllerLease(
      store,
      [account],
      'm',
      new AbortController().signal,
      10_000,
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    await Bun.sleep(10);
    const controller = new AbortController();
    const waiting = withControllerLease(store, [account], 'm', controller.signal, 10_000, () =>
      Promise.resolve('x'));
    setTimeout(() => controller.abort(new Error('gone')), 30);
    await expect(waiting).rejects.toThrow('gone');
    release();
    await holding;

    const failing = new ControllerMemoryStore();
    failing.release = () => Promise.reject(new Error('down'));
    const result = await withControllerLease(
      failing,
      [account],
      'm',
      new AbortController().signal,
      1000,
      () => Promise.resolve('ok'),
    );
    expect(result).toBe('ok');
  });

  test('Sider 会话存储有上限', () => {
    for (let index = 0; index < 2100; index++) {
      saveSiderSession(`bun-bound-${index}`, 'u', `a${index}`, 'm');
    }
    expect(getSiderSession('bun-bound-0')).toBeUndefined();
    expect(getSiderSession('bun-bound-2099')?.assistantMessageId).toBe('a2099');
  });
});
