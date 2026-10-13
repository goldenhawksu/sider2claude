import { AnthropicApiAdapter } from '../src/adapters/anthropic-adapter.ts';
import {
  BASH_RECOVERY_CASES,
  runBashRecoveryCase,
  runBashStreamRecoveryCase,
} from './fixtures/bash-recovery.ts';
import { Hono } from 'hono';

for (const sample of BASH_RECOVERY_CASES) {
  Deno.test(`Bash 纠错边界：${sample.name}`, () =>
    runBashRecoveryCase(
      new AnthropicApiAdapter({
        enabled: true,
        provider: 'anthropic-compatible',
        baseUrl: 'https://bash.example',
        apiKey: 'test-key',
        model: 'glm-5.3-flash',
      }),
      sample,
    ));
}

for (const corrected of [true, false]) {
  Deno.test(`Bash HTTP/SSE：纠错${corrected ? '成功' : '失败'}的下发边界`, async () => {
    const vars = {
      S2C_DISABLE_DOTENV: 'true',
      AUTH_TOKEN: 'test-token-12345',
      DEEPSEEK_API_KEY: 'test-key',
      DEEPSEEK_BASE_URL: 'https://bash.example',
      DEEPSEEK_MODEL: 'glm-5.3-flash',
      DEFAULT_BACKEND: 'deepseek',
      SIDER_AUTH_TOKEN: '',
      SIDER_CONTROLLER: 'false',
    };
    const previous = new Map(Object.keys(vars).map((key) => [key, Deno.env.get(key)]));
    try {
      for (const [key, value] of Object.entries(vars)) Deno.env.set(key, value);
      const { hybridMessagesRouter } = await import(
        `../src/routes/messages-hybrid.ts?bash=${crypto.randomUUID()}`
      );
      const app = new Hono();
      app.route('/v1/messages', hybridMessagesRouter);
      await runBashStreamRecoveryCase((request) =>
        app.request('/v1/messages?beta=true', {
          method: 'POST',
          headers: { authorization: 'Bearer test-token-12345', 'content-type': 'application/json' },
          body: JSON.stringify(request),
        }), corrected);
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) Deno.env.delete(key);
        else Deno.env.set(key, value);
      }
    }
  });
}
