import { type BackendConfig, loadBackendConfig } from '../src/config/backends.ts';
import { getAllModels, mapModelName } from '../src/config/models.ts';
import { RouterEngine } from '../src/routing/router-engine.ts';
import type { AnthropicRequest } from '../src/types/anthropic.ts';

function assertEquals<T>(actual: T, expected: T) {
  if (actual !== expected) {
    throw new Error(`断言失败：期望 ${String(expected)}，实际 ${String(actual)}`);
  }
}

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
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
    fn();
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

function baseConfig(): BackendConfig {
  return {
    sider: {
      enabled: true,
      apiUrl: 'https://sider.ai/api/chat/v1/completions',
      authToken: 'sider-token',
    },
    deepseek: {
      enabled: true,
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/anthropic',
      apiKey: 'deepseek-token',
      model: 'deepseek-v4-flash',
    },
    routing: {
      defaultBackend: 'sider',
      autoFallback: true,
      preferSiderForSimpleChat: true,
      debugMode: false,
    },
  };
}

function request(overrides: Partial<AnthropicRequest> = {}): AnthropicRequest {
  return {
    model: 'claude-sonnet-4.6',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 128,
    ...overrides,
  };
}

Deno.test('配置加载：DeepSeek 是默认能力补齐后端，并兼容旧 ANTHROPIC_* 环境变量', () => {
  withEnv({
    SIDER_AUTH_TOKEN: 'sider-token',
    DEEPSEEK_API_KEY: 'deepseek-token',
    DEEPSEEK_BASE_URL: undefined,
    DEEPSEEK_MODEL: undefined,
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_BASE_URL: undefined,
    DEFAULT_BACKEND: undefined,
  }, () => {
    const config = loadBackendConfig();

    assertEquals(config.sider.enabled, true);
    assertEquals(config.deepseek.enabled, true);
    assertEquals(config.deepseek.provider, 'deepseek');
    assertEquals(config.deepseek.baseUrl, 'https://api.deepseek.com/anthropic');
    assertEquals(config.deepseek.apiKey, 'deepseek-token');
    assertEquals(config.deepseek.model, 'deepseek-v4-flash');
    assertEquals(config.routing.defaultBackend, 'sider');
  });
});

Deno.test('配置加载：旧 ANTHROPIC_BASE_URL 不会覆盖 DeepSeek 官方默认入口', () => {
  withEnv({
    SIDER_AUTH_TOKEN: 'sider-token',
    DEEPSEEK_API_KEY: 'deepseek-token',
    DEEPSEEK_BASE_URL: undefined,
    DEEPSEEK_MODEL: undefined,
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_BASE_URL: 'https://legacy-compatible.example.com',
    DEFAULT_BACKEND: undefined,
  }, () => {
    const config = loadBackendConfig();

    assertEquals(config.deepseek.enabled, true);
    assertEquals(config.deepseek.provider, 'deepseek');
    assertEquals(config.deepseek.baseUrl, 'https://api.deepseek.com/anthropic');
  });
});

Deno.test('配置加载：显式 DEEPSEEK_BASE_URL 仍可覆盖默认入口', () => {
  withEnv({
    SIDER_AUTH_TOKEN: 'sider-token',
    DEEPSEEK_API_KEY: 'deepseek-token',
    DEEPSEEK_BASE_URL: 'https://deepseek-proxy.example.com/anthropic',
    DEEPSEEK_MODEL: undefined,
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_BASE_URL: 'https://legacy-compatible.example.com',
    DEFAULT_BACKEND: undefined,
  }, () => {
    const config = loadBackendConfig();

    assertEquals(config.deepseek.enabled, true);
    assertEquals(config.deepseek.provider, 'anthropic-compatible');
    assertEquals(config.deepseek.baseUrl, 'https://deepseek-proxy.example.com/anthropic');
  });
});

Deno.test('配置加载：旧 ANTHROPIC_API_KEY 可作为 DeepSeek key 兼容别名', () => {
  withEnv({
    SIDER_AUTH_TOKEN: 'sider-token',
    DEEPSEEK_API_KEY: undefined,
    DEEPSEEK_BASE_URL: undefined,
    DEEPSEEK_MODEL: undefined,
    ANTHROPIC_API_KEY: 'legacy-deepseek-token',
    ANTHROPIC_BASE_URL: undefined,
    DEFAULT_BACKEND: undefined,
  }, () => {
    const config = loadBackendConfig();

    assertEquals(config.deepseek.enabled, true);
    assertEquals(config.deepseek.provider, 'deepseek');
    assertEquals(config.deepseek.baseUrl, 'https://api.deepseek.com/anthropic');
    assertEquals(config.deepseek.apiKey, 'legacy-deepseek-token');
  });
});

Deno.test('配置加载：非 DeepSeek 的旧 ANTHROPIC_BASE_URL 会阻止旧 key 误启用官方 DeepSeek', () => {
  withEnv({
    SIDER_AUTH_TOKEN: 'sider-token',
    DEEPSEEK_API_KEY: undefined,
    DEEPSEEK_BASE_URL: undefined,
    DEEPSEEK_MODEL: undefined,
    ANTHROPIC_API_KEY: 'legacy-proxy-token',
    ANTHROPIC_BASE_URL: 'https://legacy-compatible.example.com',
    DEFAULT_BACKEND: undefined,
  }, () => {
    const config = loadBackendConfig();

    assertEquals(config.sider.enabled, true);
    assertEquals(config.deepseek.enabled, false);
    assertEquals(config.deepseek.provider, 'deepseek');
    assertEquals(config.deepseek.baseUrl, 'https://api.deepseek.com/anthropic');
    assertEquals(config.deepseek.apiKey, '');
  });
});

Deno.test('模型清单：暴露 18 个 Anthropic 模型/别名，并统一映射到 Sider 模型', () => {
  const models = getAllModels();

  assertEquals(models.length, 18);
  assertEquals(mapModelName('claude-opus-4.5'), 'claude-opus-4.6');
  assertEquals(mapModelName('claude-opus-4.5-think'), 'claude-opus-4.6-think');
  assertEquals(mapModelName('claude-sonnet-4.6'), 'claude-sonnet-4.6');
  assertEquals(mapModelName('claude-sonnet'), 'claude-sonnet-4.6');
  assertEquals(mapModelName('claude-haiku-4.5-think'), 'claude-haiku-4.5-think');
});

Deno.test('路由策略：普通 Claude 对话由 Sider 提供', () => {
  const router = new RouterEngine(baseConfig());

  const decision = router.decide(request());

  assertEquals(decision.backend, 'sider');
  assertEquals(decision.ruleId, 'rule_5_simple_chat_prefer_sider');
});

Deno.test('路由策略：Claude Code 工具能力由 DeepSeek 补齐', () => {
  const router = new RouterEngine(baseConfig());

  const decision = router.decide(request({
    tools: [{
      name: 'Bash',
      description: 'Run a command',
      input_schema: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    }],
  }));

  assertEquals(decision.backend, 'deepseek');
  assertEquals(decision.ruleId, 'rule_2_claude_tools');
  assertEquals(decision.allowFallback, false);
});

Deno.test('路由策略：MCP/自定义工具能力由 DeepSeek 补齐', () => {
  const router = new RouterEngine(baseConfig());

  const decision = router.decide(request({
    tools: [{
      name: 'mcp__filesystem__read_file',
      description: 'Read a file through MCP',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    }],
  }));

  assertEquals(decision.backend, 'deepseek');
  assertEquals(decision.ruleId, 'rule_3_mcp_tools');
  assertEquals(decision.allowFallback, false);
});

Deno.test('路由策略：工具结果回合延续上一次的 DeepSeek 后端', () => {
  const router = new RouterEngine(baseConfig());
  router.recordSessionBackend('conversation-1', 'deepseek');

  const decision = router.decide(
    request({
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_123',
          content: [{ type: 'text', text: 'done' }],
        }],
      }],
    }),
    'conversation-1',
  );

  assertEquals(decision.backend, 'deepseek');
  assertEquals(decision.ruleId, 'rule_1_tool_result_continuity');
  assertEquals(decision.allowFallback, false);
});
