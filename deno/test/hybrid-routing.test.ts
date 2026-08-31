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
      siderStrategy: 'conservative',
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

/**
 * 显式给出 DeepSeek 上游三项，验证它们被完整读取、且路由默认落到 Sider。
 *
 * 刻意**不**用「把 DEEPSEEK_BASE_URL 设为 undefined 来验证官方默认值」那种写法：
 * `withEnv` 只能删进程环境变量，而 getEnv 的优先级是「环境变量 > dotenv > 默认值」，
 * 删掉环境变量只会落到本地 dotenv，不会落到代码里的默认值。那种写法能通过
 * 纯粹是因为本地 dotenv 恰好也指向官方 DeepSeek——一旦本地切到别的兼容端
 * （如 Z.AI）就会失败，测的其实是「你本地配了什么」，不是代码行为。
 */
Deno.test('配置加载：DeepSeek 上游三项被完整读取，路由默认落到 Sider', () => {
  withEnv({
    SIDER_AUTH_TOKEN: 'sider-token',
    DEEPSEEK_API_KEY: 'deepseek-token',
    DEEPSEEK_BASE_URL: 'https://api.deepseek.com/anthropic',
    DEEPSEEK_MODEL: 'deepseek-v4-flash',
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

Deno.test('配置加载：显式 DEEPSEEK_BASE_URL 覆盖默认入口', () => {
  withEnv({
    SIDER_AUTH_TOKEN: 'sider-token',
    DEEPSEEK_API_KEY: 'deepseek-token',
    DEEPSEEK_BASE_URL: 'https://api.z.ai/anthropic',
    DEEPSEEK_MODEL: 'glm-5.3',
    DEFAULT_BACKEND: undefined,
  }, () => {
    const config = loadBackendConfig();

    assertEquals(config.deepseek.enabled, true);
    // 非 deepseek.com 的入口标记为 anthropic-compatible，仅作日志标签，不影响功能
    assertEquals(config.deepseek.provider, 'anthropic-compatible');
    assertEquals(config.deepseek.baseUrl, 'https://api.z.ai/anthropic');
    assertEquals(config.deepseek.model, 'glm-5.3');
  });
});

Deno.test('配置加载：同一环境只加载一次，环境变化时重新加载', () => {
  withEnv({
    SIDER_AUTH_TOKEN: 'sider-token',
    DEEPSEEK_API_KEY: 'deepseek-token',
    DEEPSEEK_BASE_URL: undefined,
    DEEPSEEK_MODEL: undefined,
    DEFAULT_BACKEND: undefined,
  }, () => {
    const first = loadBackendConfig();
    const second = loadBackendConfig();

    assertEquals(first === second, true);

    Deno.env.set('DEEPSEEK_MODEL', 'deepseek-v4-flash-next');
    const changed = loadBackendConfig();

    assertEquals(changed === first, false);
    assertEquals(changed.deepseek.model, 'deepseek-v4-flash-next');
  });
});

Deno.test('模型清单：暴露 67 个上游模型/别名，并统一映射到 Sider 模型', () => {
  const models = getAllModels();

  assertEquals(models.length, 67);
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

Deno.test('路由策略：PPT/长文档生成请求直接由 DeepSeek 处理，避免 Sider 长等待后回退', () => {
  const router = new RouterEngine(baseConfig());

  const decision = router.decide(request({
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: `做一个PPT，用以下内容：
一个伪心理师的呓语：
她的心里住着两个小可爱，一个叫菲卡，另一个叫查乃。

请整理为 8 页幻灯片，每页包含标题、正文要点和演讲备注。`,
    }],
  }));

  assertEquals(decision.backend, 'deepseek');
  assertEquals(decision.ruleId, 'rule_5_long_form_generation');
  assertEquals(decision.allowFallback, true);
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

Deno.test('路由策略：工具结果回合不把带工具的请求延续回 Sider', () => {
  // 没有显式 X-Conversation-ID 的多轮请求共用 `continuous-conversation` 槽位，
  // 上一回合可能只是一段纯对话（记为 sider）。Sider 不支持 Anthropic tool_use，
  // 因此本轮带工具时必须跳过延续规则，交给 DeepSeek。
  const router = new RouterEngine(baseConfig());
  router.recordSessionBackend('continuous-conversation', 'sider');

  const toolResultTurn = (toolName: string) =>
    request({
      tools: [{
        name: toolName,
        description: 'tool under test',
        input_schema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      }],
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_123',
          content: [{ type: 'text', text: 'done' }],
        }],
      }],
    });

  // Claude Code 内置工具
  const claudeCode = router.decide(toolResultTurn('Read'), 'continuous-conversation');
  assertEquals(claudeCode.backend, 'deepseek');
  assertEquals(claudeCode.ruleId, 'rule_2_claude_tools');

  // MCP / 自定义工具
  const mcp = router.decide(toolResultTurn('mcp__github__list_repos'), 'continuous-conversation');
  assertEquals(mcp.backend, 'deepseek');
  assertEquals(mcp.ruleId, 'rule_3_mcp_tools');
});

Deno.test('路由策略：不带工具的工具结果回合仍延续 Sider', () => {
  // 守卫只针对需要 tool_use 能力的请求；纯文本续轮 Sider 能服务，延续以保持上下文。
  const router = new RouterEngine(baseConfig());
  router.recordSessionBackend('conversation-sider', 'sider');

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
    'conversation-sider',
  );

  assertEquals(decision.backend, 'sider');
  assertEquals(decision.ruleId, 'rule_1_tool_result_continuity');
});

Deno.test('路由策略：带工具的工具结果回合仍可延续 DeepSeek', () => {
  // DeepSeek 支持 tool_use，延续不受守卫影响，工具上下文不断裂。
  const router = new RouterEngine(baseConfig());
  router.recordSessionBackend('conversation-deepseek', 'deepseek');

  const decision = router.decide(
    request({
      tools: [{
        name: 'Bash',
        description: 'run shell',
        input_schema: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
      }],
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_123',
          content: [{ type: 'text', text: 'done' }],
        }],
      }],
    }),
    'conversation-deepseek',
  );

  assertEquals(decision.backend, 'deepseek');
  assertEquals(decision.ruleId, 'rule_1_tool_result_continuity');
  assertEquals(decision.allowFallback, false);
});

Deno.test('会话后端记忆：cleanupExpiredSessions 按 maxAge 清理并返回条数', () => {
  const router = new RouterEngine(baseConfig());
  router.recordSessionBackend('conversation-a', 'deepseek');
  router.recordSessionBackend('conversation-b', 'sider');
  assertEquals(router.getStats().totalSessions, 2);

  // maxAge 足够大：都未过期，一条都不该清理。
  assertEquals(router.cleanupExpiredSessions(60_000), 0);
  assertEquals(router.getStats().totalSessions, 2);

  // maxAge 为负：全部视为过期。旧实现忽略入参直接清空，这里锁定按 maxAge 生效。
  assertEquals(router.cleanupExpiredSessions(-1), 2);
  assertEquals(router.getStats().totalSessions, 0);
  assertEquals(router.getSessionBackend('conversation-a'), undefined);
});

Deno.test('会话后端记忆：超过容量上限时淘汰最老条目', () => {
  const router = new RouterEngine(baseConfig());
  const limit = 500;

  for (let i = 0; i < limit + 10; i += 1) {
    router.recordSessionBackend(`conversation-${i}`, 'deepseek');
  }

  assertEquals(router.getStats().totalSessions, limit);
  // 最老的 10 条被淘汰，最新的仍在。
  assertEquals(router.getSessionBackend('conversation-0'), undefined);
  assertEquals(router.getSessionBackend('conversation-9'), undefined);
  assertEquals(router.getSessionBackend('conversation-10'), 'deepseek');
  assertEquals(router.getSessionBackend(`conversation-${limit + 9}`), 'deepseek');
});

Deno.test('会话后端记忆：重复记录会刷新最近使用顺序', () => {
  const router = new RouterEngine(baseConfig());
  router.recordSessionBackend('refreshed', 'sider');
  router.recordSessionBackend('stale', 'deepseek');
  // 再次记录让 refreshed 重新变成最近使用，避免活跃会话被误淘汰。
  router.recordSessionBackend('refreshed', 'sider');

  for (let i = 0; i < 499; i += 1) {
    router.recordSessionBackend(`filler-${i}`, 'deepseek');
  }

  assertEquals(router.getStats().totalSessions, 500);
  assertEquals(router.getSessionBackend('stale'), undefined);
  assertEquals(router.getSessionBackend('refreshed'), 'sider');
});

// ── 视觉输入路由 ────────────────────────────────────────────────────────────
//
// 上游 DeepSeek 端（实为 glm-5.3-flash）是 VLM，原生支持图文混排；Sider 通道走的
// 是另一套 multi_content 协议，实测把图片喂过去模型会答「我没有收到图片」。
// 因此带图片的请求必须避开 Sider——否则视觉能力会静默消失：HTTP 200、有回答、
// 只是模型压根没看见图。这类失败最难被使用方察觉，路由层必须挡住。

function imageRequest(extra: Partial<AnthropicRequest> = {}): AnthropicRequest {
  return request({
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
        },
        { type: 'text', text: '这张图是什么颜色？' },
      ],
    }],
    ...extra,
  } as Partial<AnthropicRequest>);
}

Deno.test('路由策略：带图片的纯对话走 DeepSeek（Sider 通道会静默丢图）', () => {
  const router = new RouterEngine(baseConfig());

  const decision = router.decide(imageRequest());

  assertEquals(decision.backend, 'deepseek');
  assertEquals(decision.ruleId, 'rule_4_vision_input');
});

Deno.test('路由策略：图片请求不允许 fallback 回 Sider', () => {
  // fallback 到 Sider 等于把图片重新丢掉一次，宁可报错也不要静默降级
  const router = new RouterEngine(baseConfig());

  const decision = router.decide(imageRequest());

  assertEquals(decision.allowFallback, false);
});

Deno.test('路由策略：多轮对话里只要出现过图片就走 DeepSeek', () => {
  const router = new RouterEngine(baseConfig());

  const decision = router.decide(request({
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
          },
          { type: 'text', text: '看这张图' },
        ],
      },
      { role: 'assistant', content: '我看到了。' },
      { role: 'user', content: '它是什么颜色？' },
    ],
  } as Partial<AnthropicRequest>));

  assertEquals(decision.backend, 'deepseek');
  assertEquals(decision.ruleId, 'rule_4_vision_input');
});

Deno.test('路由策略：纯文本的数组形态 content 不被误判为图片请求', () => {
  const router = new RouterEngine(baseConfig());

  const decision = router.decide(request({
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: '你好，请介绍一下你自己。' }],
    }],
  } as Partial<AnthropicRequest>));

  assertEquals(decision.backend, 'sider');
  assertEquals(decision.ruleId, 'rule_5_simple_chat_prefer_sider');
});

Deno.test('路由策略：图片 + Claude Code 工具仍走 DeepSeek（两条规则同向）', () => {
  const router = new RouterEngine(baseConfig());

  const decision = router.decide(imageRequest({
    tools: [{
      name: 'Read',
      description: 'read file',
      input_schema: { type: 'object', properties: { file_path: { type: 'string' } } },
    }],
  } as Partial<AnthropicRequest>));

  assertEquals(decision.backend, 'deepseek');
});
