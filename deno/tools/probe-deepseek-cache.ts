/**
 * DeepSeek prompt 缓存命中率 probe。
 *
 * 回答一个可证伪的问题：**按本服务实际发出去的字节**跑一轮 Claude Code 形态的
 * agent 循环，上游缓存能命中多少？
 *
 * 它走的是真实的 `AnthropicApiAdapter.sendRequest`，因此测的是本仓库的转录、
 * 注入、字段删除等全部行为的合成效果，而不是一个理想化的请求。
 *
 * 用法：
 *   deno task probe:cache
 *   PROBE_CACHE_TURNS=8 deno task probe:cache
 *
 * 每次运行会在 system 开头放一个唯一 nonce，保证从冷缓存起步——否则第二次运行
 * 会读到上一次的缓存，把结果刷成假的高命中率。
 */

import { AnthropicApiAdapter } from '../src/adapters/anthropic-adapter.ts';
import { loadBackendConfig } from '../src/config/backends.ts';
import type { AnthropicMessage, AnthropicRequest } from '../src/types/anthropic.ts';

/** deepseek-v4-flash 官方价（off-peak，美元/百万 token）。 */
const PRICE_CACHE_HIT = 0.007;
const PRICE_CACHE_MISS = 0.22;

interface TurnStat {
  turn: number;
  promptTokens: number;
  missTokens: number;
  creationTokens: number;
  readTokens: number;
  hitRate: number;
}

/** Claude Code 的 system prompt 量级：CLAUDE.md + 内置指引，几千 token 起步。 */
function buildSystem(nonce: string): string {
  const bulk = Array.from(
    { length: 260 },
    (_, i) =>
      `- Guideline ${i}: prefer the least surprising implementation, and keep changes surgical.`,
  ).join('\n');
  return `[probe-run ${nonce}]\nYou are Claude Code, an agentic coding assistant.\n\n${bulk}`;
}

/** Claude Code 内置工具的 schema 体量：十几个工具，渲染在最前面。 */
function buildTools(): AnthropicRequest['tools'] {
  const names = [
    'Bash',
    'Read',
    'Write',
    'Edit',
    'Glob',
    'Grep',
    'Task',
    'TodoWrite',
    'WebFetch',
    'WebSearch',
  ];
  return names.map((name) => ({
    name,
    description:
      `Execute the ${name} operation. Use this tool when the task requires ${name} semantics. ` +
      'Provide every required parameter; the tool fails closed on malformed input.',
    input_schema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Primary operand for the operation.' },
        options: { type: 'string', description: 'Optional switches, space separated.' },
      },
      required: ['target'],
    },
  }));
}

/** 第 turn 轮客户端发来的完整历史（工具结果按真实体量给，不是几个字）。 */
function buildMessages(turn: number): AnthropicMessage[] {
  const messages: AnthropicMessage[] = [
    { role: 'user', content: 'Audit the repository and report anything that looks wrong.' },
  ];

  for (let i = 0; i < turn; i += 1) {
    messages.push({
      role: 'assistant',
      content: [
        { type: 'text', text: `Step ${i}: inspecting the next module.` },
        {
          type: 'tool_use',
          id: `toolu_probe_${i}`,
          name: 'Read',
          input: { target: `src/module-${i}.ts` },
        },
      ],
    });
    messages.push({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: `toolu_probe_${i}`,
          content: Array.from(
            { length: 40 },
            (_, line) => `${line + 1}\texport const value${line} = compute(${i}, ${line});`,
          ).join('\n'),
        },
      ],
    });
  }

  return messages;
}

/**
 * A/B 用的对照组：把一段固定文字追加到**当前最后一条 user 消息**尾部。
 *
 * 这正是修复前 `applyToolProtocolInstruction` 的做法。它的隐蔽之处在于：同一条
 * 消息在下一轮不再是"最后一条"，也就不再带这段后缀，于是同一个逻辑位置在两轮
 * 之间字节不同。用 `PROBE_CACHE_MODE=tail-inject` 跑一遍就能看到代价。
 */
const TAIL_SUFFIX = '\n\n' +
  'Tool protocol: when you need a tool, emit a structured tool_use content block through the API. ' +
  'Lines like "Previous assistant tool request: name=... id=... input_json=..." and ' +
  '"Previous tool result: ..." are a read-only transcript of what already happened. ' +
  'Never reproduce those lines to request a tool, and never write textual tool-call ' +
  'transcripts such as [tool_use:Name] in normal text.';

function appendTailSuffix(messages: AnthropicMessage[]): AnthropicMessage[] {
  const next = [...messages];
  for (let i = next.length - 1; i >= 0; i -= 1) {
    const message = next[i]!;
    if (message.role !== 'user') continue;
    next[i] = {
      role: 'user',
      content: Array.isArray(message.content)
        ? [...message.content, { type: 'text', text: TAIL_SUFFIX }]
        : `${message.content}${TAIL_SUFFIX}`,
    };
    break;
  }
  return next;
}

async function main(): Promise<void> {
  const config = loadBackendConfig();
  if (!config.deepseek.enabled) {
    console.error('DeepSeek 未配置（缺 DEEPSEEK_API_KEY），probe 无法运行。');
    Deno.exit(1);
  }

  const turns = Number.parseInt(Deno.env.get('PROBE_CACHE_TURNS') ?? '6', 10);
  // 上游缓存写入不是同步的。背靠背连打会让第 N+1 轮读到第 N-1 轮的缓存，
  // 把命中率压低成假象——真实使用里两轮之间隔着人的思考时间和工具执行时间。
  const delayMs = Number.parseInt(Deno.env.get('PROBE_CACHE_DELAY_MS') ?? '0', 10);
  const tailInject = Deno.env.get('PROBE_CACHE_MODE') === 'tail-inject';
  const nonce = crypto.randomUUID();
  const system = buildSystem(nonce);
  const tools = buildTools();
  const adapter = new AnthropicApiAdapter(config.deepseek);

  console.log(`mode=${tailInject ? 'tail-inject（对照组）' : 'current（当前代码）'} turns=${turns}`);

  const stats: TurnStat[] = [];

  for (let turn = 0; turn < turns; turn += 1) {
    if (turn > 0 && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    const messages = buildMessages(turn);
    const response = await adapter.sendRequest({
      model: 'claude-sonnet-4-6',
      system,
      tools,
      // 输出量与本次测量无关，压到最小以免污染成本对比。
      max_tokens: 32,
      messages: tailInject ? appendTailSuffix(messages) : messages,
    });

    const miss = response.usage.input_tokens;
    const creation = response.usage.cache_creation_input_tokens ?? 0;
    const read = response.usage.cache_read_input_tokens ?? 0;
    const prompt = miss + creation + read;

    stats.push({
      turn,
      promptTokens: prompt,
      missTokens: miss,
      creationTokens: creation,
      readTokens: read,
      hitRate: prompt > 0 ? read / prompt : 0,
    });
  }

  report(stats);
}

function report(stats: TurnStat[]): void {
  const totalPrompt = stats.reduce((sum, s) => sum + s.promptTokens, 0);
  const totalRead = stats.reduce((sum, s) => sum + s.readTokens, 0);
  const totalMiss = totalPrompt - totalRead;
  const hitRate = totalPrompt > 0 ? totalRead / totalPrompt : 0;

  console.log('\n=== DeepSeek prompt 缓存命中率 ===');
  console.log('turn | prompt |   miss | cacheRead | hit%');
  for (const s of stats) {
    console.log(
      `${String(s.turn).padStart(4)} | ${String(s.promptTokens).padStart(6)} | ` +
        `${String(s.missTokens).padStart(6)} | ${String(s.readTokens).padStart(9)} | ` +
        `${(s.hitRate * 100).toFixed(1).padStart(5)}`,
    );
  }

  const costNow = (totalRead * PRICE_CACHE_HIT + totalMiss * PRICE_CACHE_MISS) / 1_000_000;
  const costNoCache = (totalPrompt * PRICE_CACHE_MISS) / 1_000_000;

  console.log('');
  console.log(`prompt token 合计 : ${totalPrompt}`);
  console.log(`缓存命中合计     : ${totalRead}`);
  console.log(`总体命中率       : ${(hitRate * 100).toFixed(1)}%`);
  console.log(
    `输入成本         : $${costNow.toFixed(6)}（全未命中会是 $${costNoCache.toFixed(6)}，` +
      `省 ${costNoCache > 0 ? ((1 - costNow / costNoCache) * 100).toFixed(1) : '0'}%）`,
  );
}

await main();
