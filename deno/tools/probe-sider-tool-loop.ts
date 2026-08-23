/**
 * 深度 probe：Sider 能否在纯文本通道上驱动 Claude Code 的工具循环。
 *
 * 背景：Sider 是包年订阅（边际成本 0），DeepSeek 是按量付费。因此正确的策略是
 * 「能用 Sider 完成的就不要用 DeepSeek」。当前绝大部分流量走 DeepSeek，唯一理由
 * 是 Sider 原生不提供 Anthropic `tool_use` 内容块。
 *
 * 但本代理已经有一套把文本工具调用还原成结构化 `tool_use` 的解析器
 * （parseTextualToolUseLine + schema 制导的 input_json 容错）。它当初是防御性建的，
 * 正好是在纯文本通道上驱动工具调用所需的机器。
 *
 * 本 probe 回答可证伪的问题，不是"模型自称支不支持"：
 *   A 明确给出工具 schema 与输出契约后，能否吐出可解析的调用？
 *   B 命令里带双引号时，input_json 是否仍然合法？
 *   C 不需要工具时会不会乱调（假阳性）？
 *   D 工具结果喂回后能否续轮，而不是重复调用？
 *   E 15 个工具的大 schema 会不会淹没契约？
 *   F 连续多轮循环能否收敛？
 *
 * 速率限制（约 6 次/分钟）由 sider-probe-client 统一节流与重试，被限速的样本
 * 单独计数、不计入合规率分母——否则测出来的是吞吐而不是能力。
 *
 * 用法：
 *   deno run --allow-net --allow-env --allow-read deno/tools/probe-sider-tool-loop.ts
 * 变量：
 *   SIDER_PROBE_TOOL_MODEL=claude-opus-5   SIDER_PROBE_TRIALS=5
 *   SIDER_PROBE_PACE_MS=12000              SIDER_PROBE_SUITES=A,B,E
 */

import {
  askSider,
  extractToolCall,
  numEnv,
  probeModel,
  requireToken,
} from './sider-probe-client.ts';
import { getEnv } from '../src/utils/env.ts';

requireToken();

const trials = numEnv('SIDER_PROBE_TRIALS', 5);
const suiteFilter = new Set(
  (getEnv('SIDER_PROBE_SUITES') ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(
    Boolean,
  ),
);
const wanted = (id: string) => suiteFilter.size === 0 || suiteFilter.has(id);

const SMALL_TOOLS = JSON.stringify([
  {
    name: 'Read',
    description: 'Read a file from disk',
    input_schema: {
      type: 'object',
      properties: { file_path: { type: 'string' }, limit: { type: 'number' } },
      required: ['file_path'],
    },
  },
  {
    name: 'Bash',
    description: 'Run a shell command',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string' }, description: { type: 'string' } },
      required: ['command'],
    },
  },
]);

/** 逼近 Claude Code 真实工具表规模。 */
const BIG_TOOLS = JSON.stringify(
  ([
    ['Read', 'Read a file', { file_path: 'string', limit: 'number', offset: 'number' }],
    ['Write', 'Write a file', { file_path: 'string', content: 'string' }],
    ['Edit', 'Replace a string in a file', {
      file_path: 'string',
      old_string: 'string',
      new_string: 'string',
      replace_all: 'boolean',
    }],
    ['Bash', 'Run a shell command', {
      command: 'string',
      description: 'string',
      timeout: 'number',
      run_in_background: 'boolean',
    }],
    ['Glob', 'Fast file pattern matching', { pattern: 'string', path: 'string' }],
    ['Grep', 'Content search built on ripgrep', {
      pattern: 'string',
      path: 'string',
      glob: 'string',
      output_mode: 'string',
      '-n': 'boolean',
      context: 'number',
    }],
    ['Task', 'Launch a subagent', {
      description: 'string',
      prompt: 'string',
      subagent_type: 'string',
    }],
    ['TodoWrite', 'Update the task list', { todos: 'array' }],
    ['WebFetch', 'Fetch a URL', { url: 'string', prompt: 'string' }],
    ['WebSearch', 'Search the web', { query: 'string', allowed_domains: 'array' }],
    ['NotebookEdit', 'Edit a notebook cell', {
      notebook_path: 'string',
      cell_id: 'string',
      new_source: 'string',
    }],
    ['Skill', 'Invoke a packaged skill', { skill: 'string', args: 'string' }],
    ['SlashCommand', 'Run a slash command', { command: 'string' }],
    ['ExitPlanMode', 'Finish planning', {}],
    ['AskUserQuestion', 'Ask the user a question', { questions: 'array' }],
  ] as Array<[string, string, Record<string, string>]>).map(([name, description, props]) => ({
    name,
    description,
    input_schema: {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(props).map(([key, type]) => [key, { type }]),
      ),
    },
  })),
);

function contract(tools: string): string {
  return `You have access to these tools:

${tools}

To call a tool, output a line in EXACTLY this format, on its own line, nothing after it:
[tool_use:ToolName] id=call_<random> input={<compact JSON matching input_schema>}

Rules:
- Emit at most one tool call per reply.
- input must be valid compact JSON on a single line.
- If no tool is needed, just answer normally and never emit that line.`;
}

interface SuiteTally {
  pass: number;
  fail: number;
  throttled: number;
}

async function runSuite(
  id: string,
  label: string,
  prompt: string,
  expect: 'tool' | 'no-tool',
): Promise<SuiteTally | undefined> {
  if (!wanted(id)) return undefined;

  console.log(`\n=== ${id} ${label}（${trials} 次）===`);
  const tally: SuiteTally = { pass: 0, fail: 0, throttled: 0 };

  for (let i = 1; i <= trials; i += 1) {
    const result = await askSider(prompt);
    if (result.kind === 'throttled') {
      tally.throttled += 1;
      console.log(`  ${i}. ⏳ 限速（不计入合规率）`);
      continue;
    }
    if (result.kind !== 'ok') {
      tally.fail += 1;
      console.log(`  ${i}. ❌ ${result.kind}: ${result.detail}`);
      continue;
    }

    const call = extractToolCall(result.text);
    const good = expect === 'tool' ? !!call : !call;
    if (good) tally.pass += 1;
    else tally.fail += 1;

    if (expect === 'tool') {
      console.log(
        good
          ? `  ${i}. ✅ ${call!.name} ${JSON.stringify(call!.input).slice(0, 90)}`
          : `  ${i}. ❌ 未产出可解析调用｜原文: ${result.text.replace(/\s+/g, ' ').slice(0, 80)}`,
      );
    } else {
      console.log(
        good ? `  ${i}. ✅ 未误调用` : `  ${i}. ❌ 不该调用却调用了 ${call!.name}`,
      );
    }
  }

  const denom = tally.pass + tally.fail;
  console.log(
    `  → 合规 ${tally.pass}/${denom}${
      tally.throttled ? `（另有 ${tally.throttled} 次被限速，已剔除）` : ''
    }`,
  );
  return tally;
}

console.log(`模型: ${probeModel} | 每组 ${trials} 次`);

const tallies: Array<[string, SuiteTally | undefined]> = [];

tallies.push([
  'A 单轮工具调用',
  await runSuite(
    'A',
    '单轮工具调用',
    `${contract(SMALL_TOOLS)}\n\nUser request: 请读取 deno/src/config/models.ts 的前 60 行。`,
    'tool',
  ),
]);

tallies.push([
  'B 带双引号的命令',
  await runSuite(
    'B',
    '带双引号的命令（考验 input_json 转义）',
    `${
      contract(SMALL_TOOLS)
    }\n\nUser request: 运行命令，打印一行 "=== hello ==="，然后列出当前目录。`,
    'tool',
  ),
]);

tallies.push([
  'C 无需工具时的克制',
  await runSuite(
    'C',
    '无需工具时不得乱调',
    `${contract(SMALL_TOOLS)}\n\nUser request: 用一句话解释什么是幂等性。`,
    'no-tool',
  ),
]);

tallies.push([
  'D 工具结果续轮',
  await runSuite(
    'D',
    '工具结果续轮不重复调用',
    `${contract(SMALL_TOOLS)}

Conversation so far:
User: 请读取 config.json 并告诉我 port 是多少。
Assistant: [tool_use:Read] id=call_prev_1 input={"file_path":"config.json"}
Tool result for call_prev_1: {"port": 8080, "host": "localhost"}

Now continue: 根据上面的工具结果直接回答用户，不要再调用工具。`,
    'no-tool',
  ),
]);

tallies.push([
  'E 大工具表下的契约',
  await runSuite(
    'E',
    '15 个工具的大 schema 下契约是否被淹没',
    `${contract(BIG_TOOLS)}\n\nUser request: 帮我在仓库里搜索所有包含 "deepseekReason" 的文件。`,
    'tool',
  ),
]);

// F：连续多轮循环（用 cid 续轮，逼近真实 agent 循环的载荷形态）
if (wanted('F')) {
  console.log('\n=== F 连续多轮工具循环（cid 续轮，最多 5 轮）===');
  const fakeResults: Record<string, string> = {
    Glob: 'deno/src/utils/usage-stats.ts',
    Grep: 'deno/src/utils/usage-stats.ts:91: deepseekReason?: DeepSeekReason',
    Read: 'export type DeepSeekReason = "tools" | "fallback" | "routing";',
    Bash: 'ok | 122 passed | 0 failed',
  };

  const first = await askSider(
    `${
      contract(BIG_TOOLS)
    }\n\n任务：找到定义 DeepSeekReason 的文件，读出定义，然后跑测试确认没坏。`,
  );
  if (first.kind !== 'ok') {
    console.log(`  轮1 ❌ ${first.kind}: ${first.detail}`);
  } else {
    const cid = first.cid;
    let parent = first.assistant;
    let call = extractToolCall(first.text);
    let converged = false;
    console.log(
      `  轮1 载荷 ${first.bytes} 字节 -> ${
        call ? `${call.name} ${JSON.stringify(call.input).slice(0, 60)}` : '（无调用）'
      }`,
    );

    for (let round = 2; round <= 5 && call; round += 1) {
      const feed = `工具 ${call.name} 的执行结果：\n${
        fakeResults[call.name] ?? '(ok)'
      }\n\n请继续。若信息已足够就直接给结论，不要再调用工具。`;
      const next = await askSider(feed, { cid, parent });
      if (next.kind !== 'ok') {
        console.log(`  轮${round} ❌ ${next.kind}: ${next.detail}`);
        break;
      }
      parent = next.assistant || parent;
      call = extractToolCall(next.text);
      if (call) {
        console.log(
          `  轮${round} 载荷 ${next.bytes} 字节 -> ${call.name} ${
            JSON.stringify(call.input).slice(0, 60)
          }`,
        );
      } else {
        console.log(
          `  轮${round} 载荷 ${next.bytes} 字节 -> ✅ 收敛: ${
            next.text.replace(/\s+/g, ' ').slice(0, 90)
          }`,
        );
        converged = true;
      }
    }
    console.log(`  → ${converged ? '✅ 循环能收敛' : '⚠️ 未在 5 轮内收敛'}`);
  }
}

console.log(`\n===== ${probeModel} 汇总 =====`);
let totalPass = 0;
let totalDenom = 0;
let totalThrottled = 0;
for (const [label, tally] of tallies) {
  if (!tally) continue;
  const denom = tally.pass + tally.fail;
  totalPass += tally.pass;
  totalDenom += denom;
  totalThrottled += tally.throttled;
  console.log(`  ${label}: ${tally.pass}/${denom}`);
}
console.log(
  `  合计契约合规率: ${totalPass}/${totalDenom}` +
    `${totalThrottled ? `（被限速 ${totalThrottled} 次，已剔除）` : ''}`,
);
