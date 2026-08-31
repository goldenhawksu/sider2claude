/**
 * 上游 prompt 缓存相关的回归测试。
 *
 * 背景：DeepSeek 的缓存命中价是未命中的 1/31（$0.007 vs $0.22 每百万 token），
 * 而缓存命中完全没有外部现象——坏掉了只体现在账单上。所以这里的断言必须
 * 长期守着两件事：
 *   1. 上游 usage 里的缓存字段必须一路透传到统计，否则命中率不可观测；
 *   2. 发往上游的请求前缀必须在多轮之间逐字节稳定，否则每轮都从头未命中。
 */

import { AnthropicApiAdapter } from '../src/adapters/anthropic-adapter.ts';
import type { AnthropicMessage, AnthropicRequest } from '../src/types/anthropic.ts';
import { getUsageSnapshot, recordUsage, resetUsageStats } from '../src/utils/usage-stats.ts';

function assertEquals<T>(actual: T, expected: T, message?: string) {
  if (actual !== expected) {
    throw new Error(
      `${message ? message + '：' : '断言失败：'}期望 ${String(expected)}，实际 ${String(actual)}`,
    );
  }
}

function newAdapter(): AnthropicApiAdapter {
  return new AnthropicApiAdapter({
    enabled: true,
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/anthropic',
    apiKey: 'deepseek-token',
    model: 'deepseek-v4-flash',
  });
}

/** 捕获实际发往上游的请求体；可指定上游返回的 usage。 */
function stubUpstream(
  captured: AnthropicRequest[],
  usage: Record<string, number>,
): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    captured.push(JSON.parse(init?.body as string) as AnthropicRequest);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'deepseek-v4-flash',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

Deno.test('上游 usage 的缓存字段必须透传，不能在归一化时被砍掉', async () => {
  const captured: AnthropicRequest[] = [];
  const restore = stubUpstream(captured, {
    input_tokens: 10,
    output_tokens: 5,
    cache_creation_input_tokens: 128,
    cache_read_input_tokens: 4480,
  });

  try {
    const response = await newAdapter().sendRequest({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 64,
    });

    assertEquals(response.usage.input_tokens, 10, 'input_tokens');
    assertEquals(response.usage.output_tokens, 5, 'output_tokens');
    assertEquals(response.usage.cache_read_input_tokens, 4480, 'cache_read_input_tokens');
    assertEquals(response.usage.cache_creation_input_tokens, 128, 'cache_creation_input_tokens');
  } finally {
    restore();
  }
});

Deno.test('上游未返回缓存字段时不伪造 0，保持 undefined', async () => {
  const captured: AnthropicRequest[] = [];
  const restore = stubUpstream(captured, { input_tokens: 10, output_tokens: 5 });

  try {
    const response = await newAdapter().sendRequest({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 64,
    });

    assertEquals(response.usage.cache_read_input_tokens, undefined, 'cache_read_input_tokens');
    assertEquals(
      response.usage.cache_creation_input_tokens,
      undefined,
      'cache_creation_input_tokens',
    );
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// 前缀稳定性
// ---------------------------------------------------------------------------

const TOOLS: AnthropicRequest['tools'] = [
  {
    name: 'Bash',
    description: 'Run a shell command',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
];

const SYSTEM = 'You are Claude Code.\n\n' + 'Guideline line.\n'.repeat(50);

/** 模拟 Claude Code agent 循环里第 turn 轮客户端会发来的完整历史。 */
function agentLoopMessages(turn: number): AnthropicMessage[] {
  const messages: AnthropicMessage[] = [
    { role: 'user', content: 'List the files in the project root.' },
  ];

  for (let i = 0; i < turn; i += 1) {
    messages.push({
      role: 'assistant',
      content: [
        { type: 'text', text: `Step ${i}: running a command.` },
        { type: 'tool_use', id: `toolu_${i}`, name: 'Bash', input: { command: `ls dir${i}` } },
      ],
    });
    messages.push({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: `toolu_${i}`, content: `file-${i}.txt` },
      ],
    });
  }

  return messages;
}

function baseRequest(turn: number): AnthropicRequest {
  return {
    model: 'claude-sonnet-4-6',
    system: SYSTEM,
    tools: TOOLS,
    max_tokens: 1024,
    messages: agentLoopMessages(turn),
  };
}

/**
 * 前缀是不是稳定，判据就是「上一轮发出去的东西，是这一轮发出去的东西的严格前缀」。
 * 渲染顺序是 tools -> system -> messages，所以三段都要比。
 */
function assertStablePrefix(earlier: AnthropicRequest, later: AnthropicRequest): void {
  assertEquals(
    JSON.stringify(earlier.tools),
    JSON.stringify(later.tools),
    'tools 必须逐字节一致（它渲染在最前面，一变整段缓存作废）',
  );
  assertEquals(
    JSON.stringify(earlier.system),
    JSON.stringify(later.system),
    'system 必须逐字节一致',
  );

  if (earlier.messages.length > later.messages.length) {
    throw new Error('断言失败：后一轮的消息数不应少于前一轮');
  }

  for (let i = 0; i < earlier.messages.length; i += 1) {
    assertEquals(
      JSON.stringify(later.messages[i]),
      JSON.stringify(earlier.messages[i]),
      `messages[${i}] 在两轮之间发生了变化，缓存前缀会在这里断掉`,
    );
  }
}

Deno.test('发往上游的请求前缀在多轮 agent 循环之间逐字节稳定', async () => {
  const captured: AnthropicRequest[] = [];
  const restore = stubUpstream(captured, { input_tokens: 10, output_tokens: 5 });

  try {
    const adapter = newAdapter();
    for (let turn = 0; turn <= 3; turn += 1) {
      await adapter.sendRequest(baseRequest(turn));
    }
  } finally {
    restore();
  }

  assertEquals(captured.length, 4, '应捕获 4 轮请求');
  for (let i = 1; i < captured.length; i += 1) {
    assertStablePrefix(captured[i - 1]!, captured[i]!);
  }
});

// ---------------------------------------------------------------------------
// tool_choice：能原生透传的就别注入文本
//
// 实测（deno/tools/probe-deepseek-tool-choice.ts）：DeepSeek 的 Anthropic 兼容端
// 接受 auto / any / none，只有 `{type:'tool'}` 会 400
// （"Thinking mode does not support this tool_choice"）。
// 前三种改为原生透传，尾部就少一处逐轮变化的文本。
// ---------------------------------------------------------------------------

async function captureWithToolChoice(
  toolChoice: AnthropicRequest['tool_choice'],
): Promise<AnthropicRequest> {
  const captured: AnthropicRequest[] = [];
  const restore = stubUpstream(captured, { input_tokens: 10, output_tokens: 5 });
  try {
    await newAdapter().sendRequest({
      model: 'claude-sonnet-4-6',
      system: SYSTEM,
      tools: TOOLS,
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'do it' }],
      tool_choice: toolChoice,
    });
  } finally {
    restore();
  }
  return captured[0]!;
}

function lastUserText(request: AnthropicRequest): string {
  for (let i = request.messages.length - 1; i >= 0; i -= 1) {
    const message = request.messages[i]!;
    if (message.role === 'user') {
      return typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
    }
  }
  return '';
}

Deno.test('tool_choice=any 原生透传，不再往消息尾部注入文本', async () => {
  const sent = await captureWithToolChoice({ type: 'any' });
  assertEquals(JSON.stringify(sent.tool_choice), JSON.stringify({ type: 'any' }), 'tool_choice');
  assertEquals(lastUserText(sent).includes('Tool choice requirement'), false, '不应注入文本');
});

Deno.test('tool_choice=auto 原生透传，不注入文本', async () => {
  const sent = await captureWithToolChoice({ type: 'auto' });
  assertEquals(JSON.stringify(sent.tool_choice), JSON.stringify({ type: 'auto' }), 'tool_choice');
  assertEquals(lastUserText(sent).includes('Tool choice requirement'), false, '不应注入文本');
});

Deno.test('tool_choice=none 摘掉 tools 兑现语义，且绝不退化成"调用名为 undefined 的工具"', async () => {
  // 原先这里断言 none 原生透传。后来 probe 实测上游**完全忽略 tool_choice**
  // （no/auto/any/tool/none 五种形态返回一模一样的 tool_use，见
  // tools/probe-deepseek-tool-choice.ts），透传等于让 none 静默失效——调用方明确
  // 禁止用工具，却照样拿到 tool_use。所以改为摘掉 tools 来兑现语义，
  // 见 tool-choice-none.test.ts。
  //
  // 本用例保留的是它真正的防线：none 绝不能退化进"强制指定工具"分支，
  // 那会注入一句 named "undefined" 的鬼话（历史上真的发生过）。
  const sent = await captureWithToolChoice({ type: 'none' });
  assertEquals(sent.tool_choice, undefined, 'none 时 tool_choice 一并摘掉');
  assertEquals(sent.tools, undefined, 'none 时 tools 必须摘掉，否则上游照调不误');
  const text = lastUserText(sent);
  assertEquals(text.includes('undefined'), false, '不得出现 undefined 工具名');
  assertEquals(text.includes('Tool choice requirement'), false, '不应注入文本');
});

Deno.test('tool_choice=tool 仍走文本兜底（上游对它返回 400）', async () => {
  const sent = await captureWithToolChoice({ type: 'tool', name: 'Bash' });
  assertEquals(sent.tool_choice, undefined, '强制指定工具必须从请求里摘掉');
  assertEquals(
    lastUserText(sent).includes('Tool choice requirement: call the tool named "Bash"'),
    true,
    '意图必须用文本保留',
  );
});

// ---------------------------------------------------------------------------
// 统计：命中率必须可观测
//
// 注意 `inputTokens` 的语义是**未命中的余量**（上游 usage 里的 input_tokens），
// 不是 prompt 总量。这正是成本相关的那个数：它按未命中价计费，而
// cacheReadTokens 按 1/31 的命中价计费。分开存才能算出成本。
// ---------------------------------------------------------------------------

Deno.test({
  name: '统计：缓存 token 计入总量并算出命中率',
  sanitizeResources: false,
  sanitizeOps: false,
  fn() {
    resetUsageStats();

    recordUsage({
      model: 'claude-sonnet-4-6',
      backend: 'deepseek',
      fallback: false,
      toolUses: [],
      stream: false,
      ms: 10,
      inputTokens: 700,
      outputTokens: 50,
      cacheReadTokens: 6300,
      cacheCreationTokens: 0,
    });

    const snapshot = getUsageSnapshot();
    assertEquals(snapshot.totals.inputTokens, 700, 'inputTokens 仍是未命中余量');
    assertEquals(snapshot.totals.cacheReadTokens, 6300, 'cacheReadTokens');
    assertEquals(snapshot.totals.cacheCreationTokens, 0, 'cacheCreationTokens');
    // 6300 / (700 + 6300 + 0) = 90.0%
    assertEquals(snapshot.totals.cacheHitRate, '90.0%', 'cacheHitRate');
  },
});

Deno.test({
  name: '统计：没有任何 prompt token 时命中率是 0% 而非除零',
  sanitizeResources: false,
  sanitizeOps: false,
  fn() {
    resetUsageStats();
    assertEquals(getUsageSnapshot().totals.cacheHitRate, '0.0%', 'cacheHitRate');
  },
});

Deno.test({
  name: '统计：上游未上报缓存字段的请求不污染命中率分母之外的口径',
  sanitizeResources: false,
  sanitizeOps: false,
  fn() {
    resetUsageStats();
    // Sider 侧不返回缓存字段，缺省按 0 计；它仍然进 inputTokens。
    recordUsage({
      model: 'claude-sonnet-4-6',
      backend: 'sider',
      fallback: false,
      toolUses: [],
      stream: false,
      ms: 10,
      inputTokens: 1000,
      outputTokens: 20,
    });

    const totals = getUsageSnapshot().totals;
    assertEquals(totals.cacheReadTokens, 0, 'cacheReadTokens');
    assertEquals(totals.cacheHitRate, '0.0%', 'cacheHitRate');
  },
});


