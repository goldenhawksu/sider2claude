import { Hono } from 'hono';
import { requireAuth } from '../src/middleware/auth.ts';

function assertEquals<T>(actual: T, expected: T) {
  if (actual !== expected) {
    throw new Error(`断言失败：期望 ${String(expected)}，实际 ${String(actual)}`);
  }
}

async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>) {
  const previous = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, Deno.env.get(key));
    if (value === undefined) {
      Deno.env.delete(key);
    } else {
      Deno.env.set(key, value);
    }
  }

  try {
    await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        Deno.env.delete(key);
      } else {
        Deno.env.set(key, value);
      }
    }
  }
}

function protectedApp(): Hono {
  const app = new Hono();
  app.use('*', requireAuth);
  app.get('/protected', (c) => c.json({ ok: true }));
  return app;
}

Deno.test('认证：配置 AUTH_TOKEN 时 dummy 默认被拒绝', async () => {
  await withEnv({
    AUTH_TOKEN: 'real-token',
    ALLOW_DUMMY_TOKEN: undefined,
  }, async () => {
    const app = protectedApp();

    const dummyResponse = await app.request('/protected', {
      headers: { Authorization: 'Bearer dummy' },
    });
    assertEquals(dummyResponse.status, 401);

    const realResponse = await app.request('/protected', {
      headers: { Authorization: 'Bearer real-token' },
    });
    assertEquals(realResponse.status, 200);
  });
});

Deno.test('认证：只有显式开启 ALLOW_DUMMY_TOKEN 才接受 dummy', async () => {
  await withEnv({
    AUTH_TOKEN: 'real-token',
    ALLOW_DUMMY_TOKEN: 'true',
  }, async () => {
    const app = protectedApp();

    const response = await app.request('/protected', {
      headers: { Authorization: 'Bearer dummy' },
    });

    assertEquals(response.status, 200);
  });
});
