/**
 * 文本形式工具调用的还原。
 *
 * 背景：发往上游的历史工具轮会被转录成文本（`[tool_use:Name] id=X input={...}`），
 * 上游随后会把这个转录格式当成调用协议模仿，输出纯文本的「工具调用」。不还原它，
 * 响应就退化成 `stop_reason: end_turn` 且无 `tool_use` 块，Claude Code 据此判定
 * 回合结束、**agent 循环提前停止**——现象只是「助手莫名停下、要人说『请继续』」。
 *
 * Sider 通道（Max 策略）反过来利用同一套格式：主动把契约注入 prompt，要求模型
 * 按这个格式发起调用，再用同一个解析器还原。转录格式、契约格式、解析格式三者
 * 必须始终同构，改任何一个都要同步改另外两个。
 *
 * 为什么独立成模块而不是各处复制：这套解析器的每一类畸形修复都是实测换来的
 * （未转义反斜杠、未转义内层双引号、schema 制导的值终止符判据），两份副本必然
 * 漂移，而漂移的表现就是「Claude Code 每隔几轮停一次」。
 */

import type { AnthropicRequest, AnthropicResponseContent } from '../types/anthropic';

/**
 * 解析模型模仿产出的 input_json。
 *
 * 三级递进，每级都比上一级更宽容，但都必须以「能解析成合法对象」收尾；
 * 全部失败就返回 undefined，老实退回文本 —— 宁可少还原一次，也不能伪造
 * 出参数错误的工具调用（对 Bash/Write 这类写操作尤其重要）。
 *
 * 1. 严格 JSON。
 * 2. 补未转义的反斜杠。转录由 `JSON.stringify` 生成，Windows 路径在里面是
 *    `C:\\Users`；模型模仿时几乎必然按人类写法还原成 `C:\Users`，
 *    `JSON.parse` 抛 "Bad escaped character"。
 * 3. 补未转义的内层双引号。命令里带引号是常态（`echo "x"`、`python -c "…"`、
 *    `curl -H "…"`），模型模仿时同样不会转义，字面量边界因此错位。
 *
 * 三级失败会让响应退化成 end_turn，Claude Code 判定回合结束、agent 循环停止。
 */
export function parseLooseToolInputJson(
  inputText: string,
  allowedKeys?: ReadonlySet<string>,
): unknown {
  try {
    return JSON.parse(inputText);
  } catch {
    // 继续尝试修补
  }

  try {
    return JSON.parse(repairJsonBackslashes(inputText));
  } catch {
    // 继续尝试修补
  }

  const quoted = escapeInnerQuotes(inputText, allowedKeys);
  if (!quoted) {
    return undefined;
  }

  try {
    return JSON.parse(repairJsonBackslashes(quoted));
  } catch {
    return undefined;
  }
}

/**
 * 把字符串值内部未转义的双引号补成 `\"`，据此还原正确的字面量边界。
 *
 * 难点是判断一个 `"` 到底是「值结束」还是「值内容」。通用 JSON 修复器只能
 * 看字符串猜，于是在 `{"command":"echo "a", b"}` 这类输入上必须在「截断」和
 * 「合并」之间赌一把——赌错方向会把 `rm -rf /tmp/x` 截成 `rm -rf /`。
 *
 * 但我们是协议代理，手里有这个工具的 `input_schema`，于是可以把猜测换成
 * **有判据的假设检验**：一个 `"` 只有在其后紧跟 `,"<本工具声明过的键>":`
 * 时才算值结束。`echo "a", b` 里的逗号后面是 ` b`，不是合法键，因此不构成
 * 终止符，命令不会被截断。
 *
 * 候选取**最早**的合法键终止符（而不是最晚）：取最晚会把后续字段一并吞进
 * 前一个值。若一个合法键终止符都没有，才退化为「值一直延伸到对象结束」——
 * 这个方向只会让内容偏多，不会截断，对 shell 命令是更安全的失败方向。
 *
 * 拿不到 schema（请求未带 tools，或工具名对不上）时退回「键形」正则判据，
 * 弱一些，但仍远强于裸逗号。
 *
 * 已知局限：命令内容里若真的出现 `","<本工具的合法键>":` 会被误判为字段
 * 分隔。构造出这种命令需要刻意为之，实践中不出现。
 */
function escapeInnerQuotes(
  text: string,
  allowedKeys?: ReadonlySet<string>,
): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return undefined;
  }

  let out = '{';
  let index = 1;

  const skipWhitespace = () => {
    while (index < trimmed.length && /\s/.test(trimmed[index] ?? '')) {
      out += trimmed[index];
      index += 1;
    }
  };

  while (true) {
    skipWhitespace();
    if (trimmed[index] === '}') {
      return out + trimmed.slice(index);
    }
    // 键本身被模型写坏的情况实践中不出现，按严格规则读；读不出就整体放弃。
    if (trimmed[index] !== '"') {
      return undefined;
    }

    const key = readStringLiteral(trimmed, index);
    if (!key) {
      return undefined;
    }
    out += `"${key.body}"`;
    index = key.end;

    skipWhitespace();
    if (trimmed[index] !== ':') {
      return undefined;
    }
    out += ':';
    index += 1;
    skipWhitespace();

    if (trimmed[index] === '"') {
      const end = findStringValueEnd(trimmed, index, allowedKeys);
      if (end === undefined) {
        return undefined;
      }
      out += `"${escapeRawQuotes(trimmed.slice(index + 1, end))}"`;
      index = end + 1;
    } else {
      const end = findNonStringValueEnd(trimmed, index);
      if (end === undefined) {
        return undefined;
      }
      out += trimmed.slice(index, end);
      index = end;
    }

    skipWhitespace();
    if (trimmed[index] === ',') {
      out += ',';
      index += 1;
      continue;
    }
    if (trimmed[index] === '}') {
      return out + trimmed.slice(index);
    }
    return undefined;
  }
}

/** 值内容里一个 `"` 是否构成字面量结束：后面必须是合法键，或对象结束。 */
function isValueTerminator(
  text: string,
  after: number,
  allowedKeys?: ReadonlySet<string>,
): 'key' | 'end' | undefined {
  const rest = text.slice(after);
  if (/^\s*\}\s*$/.test(rest)) {
    return 'end';
  }
  const nextKey = rest.match(/^\s*,\s*"([^"\\]*)"\s*:/);
  if (!nextKey) {
    return undefined;
  }
  const name = nextKey[1] ?? '';
  const looksLikeKey = allowedKeys ? allowedKeys.has(name) : /^[A-Za-z_-][\w-]*$/.test(name);
  return looksLikeKey ? 'key' : undefined;
}

/** 定位字符串值的结束引号；start 指向起始引号。 */
function findStringValueEnd(
  text: string,
  start: number,
  allowedKeys?: ReadonlySet<string>,
): number | undefined {
  let objectEnd: number | undefined;

  for (let i = start + 1; i < text.length; i += 1) {
    if (text[i] === '\\') {
      i += 1; // 连同被转义的字符整体跳过
      continue;
    }
    if (text[i] !== '"') {
      continue;
    }

    const kind = isValueTerminator(text, i + 1, allowedKeys);
    if (kind === 'key') {
      return i; // 最早的合法键终止符即为答案
    }
    if (kind === 'end' && objectEnd === undefined) {
      objectEnd = i;
    }
  }

  return objectEnd;
}

/** 定位非字符串值（数字/布尔/null/数组/对象）的结束位置。 */
function findNonStringValueEnd(text: string, start: number): number | undefined {
  let depth = 0;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      const literal = readStringLiteral(text, i);
      if (!literal) return undefined;
      i = literal.end - 1;
      continue;
    }
    if (char === '[' || char === '{') {
      depth += 1;
      continue;
    }
    if (char === ']' || char === '}') {
      if (depth === 0) return i;
      depth -= 1;
      continue;
    }
    if (char === ',' && depth === 0) {
      return i;
    }
  }

  return undefined;
}

/** 保留已转义的 `\"`，把裸引号补成 `\"`。反斜杠的修补交给后一级。 */
function escapeRawQuotes(body: string): string {
  let out = '';
  let index = 0;

  while (index < body.length) {
    const char = body[index];
    if (char === '\\') {
      out += char + (body[index + 1] ?? '');
      index += 2;
      continue;
    }
    out += char === '"' ? '\\"' : char;
    index += 1;
  }

  return out;
}

/** JSON 规范允许的转义字符。其余跟在反斜杠后的字符都属于非法转义。 */
const LEGAL_JSON_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't']);

/**
 * 把 JSON 文本里未转义的反斜杠补成 `\\`，逐个字符串字面量处理。
 *
 * 难点是 `\b` `\f` `\n` `\r` `\t` 既是合法转义，也是 Windows 路径的常见开头
 * （`\bin`、`\node_modules`、`\report`、`\temp`）。单看转义序列无法消歧，
 * 因此先取出整个字面量判断它像不像路径（盘符前缀）：
 * - 像路径 → 按反斜杠连续段的奇偶判断：奇数段是模型漏转义的分隔符，补成双份；
 *   偶数段说明这一段本来就转义正确，原样保留。这样同一个对象里混有
 *   「转对的」和「没转对的」路径时都能得到正确值。
 * - 不像路径 → 合法转义照常生效，只补救非法转义。
 *
 * 已知局限：UNC 前缀 `\\server` 与「一个已正确转义的分隔符」字面同形，
 * 无法区分，会被当作后者。UNC 路径在 Claude Code 场景中极少出现，
 * 且误判只影响这一个前缀，不会让整体解析失败。
 */
function repairJsonBackslashes(text: string): string {
  let out = '';
  let index = 0;

  while (index < text.length) {
    const char = text[index];
    if (char !== '"') {
      out += char;
      index += 1;
      continue;
    }

    const literal = readStringLiteral(text, index);
    if (!literal) {
      // 引号未闭合，交给 JSON.parse 去报错。
      out += text.slice(index);
      break;
    }

    out += `"${rewriteLiteralBody(literal.body)}"`;
    index = literal.end;
  }

  return out;
}

/** 从 start 处的引号开始读一个字符串字面量，返回原始内容与结束位置（引号后一位）。 */
function readStringLiteral(
  text: string,
  start: number,
): { body: string; end: number } | undefined {
  let index = start + 1;
  let body = '';

  while (index < text.length) {
    const char = text[index];
    if (char === '\\') {
      // 无论转义是否合法，都连同下一个字符整体带走，避免把 \" 误判成结束引号。
      body += char + (text[index + 1] ?? '');
      index += 2;
      continue;
    }
    if (char === '"') {
      return { body, end: index + 1 };
    }
    body += char;
    index += 1;
  }

  return undefined;
}

function rewriteLiteralBody(body: string): string {
  return looksLikeWindowsPath(body) ? rewritePathLiteral(body) : rewritePlainLiteral(body);
}

/** 路径字面量：反斜杠一律是分隔符，按连续段奇偶决定是否补转义。 */
function rewritePathLiteral(body: string): string {
  let out = '';
  let index = 0;

  while (index < body.length) {
    if (body[index] !== '\\') {
      out += body[index];
      index += 1;
      continue;
    }

    let run = 0;
    while (body[index + run] === '\\') {
      run += 1;
    }

    // 段尾紧跟引号时，最后一个反斜杠属于 \" 转义，不算分隔符。
    const followedByQuote = body[index + run] === '"';
    const separators = followedByQuote ? run - 1 : run;

    // 偶数段 = 已经转义正确，原样保留；奇数段 = 漏转义，补成双份。
    out += separators % 2 === 0 ? '\\'.repeat(separators) : '\\'.repeat(separators * 2);

    if (followedByQuote) {
      out += '\\"';
      index += run + 1;
    } else {
      index += run;
    }
  }

  return out;
}

/** 非路径字面量：合法转义原样生效，只补救非法转义。 */
function rewritePlainLiteral(body: string): string {
  let out = '';
  let index = 0;

  while (index < body.length) {
    if (body[index] !== '\\') {
      out += body[index];
      index += 1;
      continue;
    }

    const next = body[index + 1];
    if (next === undefined) {
      out += '\\\\';
      index += 1;
      continue;
    }

    if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(body.slice(index + 2, index + 6))) {
      out += body.slice(index, index + 6);
      index += 6;
      continue;
    }

    out += LEGAL_JSON_ESCAPES.has(next) ? `\\${next}` : `\\\\${next}`;
    index += 2;
  }

  return out;
}

/** 盘符前缀 —— 判定该字面量整体是 Windows 路径。 */
function looksLikeWindowsPath(body: string): boolean {
  return /^[A-Za-z]:\\/.test(body);
}

/**
 * 「这一行形状像文本工具调用」的判据，只看结构不看 JSON 是否合法。
 * 用于统计兜底漏掉的次数——解析失败与「本来就不是调用」必须分开计数，
 * 否则前者会静默混进普通文本里，只表现为"助手莫名停下"。
 */
export const TEXTUAL_TOOL_LINE_SHAPE =
  /^(Previous assistant tool request:\s*name=\S+\s+id=\S+\s+input_json=\{|\[tool_use:[^\]]+\]\s+id=\S+\s+input=\{)/;

/**
 * 采集各工具 `input_schema` 声明的合法键。
 *
 * 这是 schema 制导修复的判据来源：修复未转义的内层双引号时，靠它判断
 * 一个 `"` 后面跟的到底是真字段分隔，还是命令内容里恰好出现的逗号加引号。
 * 通用 JSON 修复器没有这个信息，只能猜。
 */
export function collectToolInputKeys(
  tools: AnthropicRequest['tools'],
): Map<string, ReadonlySet<string>> {
  const map = new Map<string, ReadonlySet<string>>();

  for (const tool of tools ?? []) {
    const name = (tool as { name?: unknown }).name;
    const properties = (tool as { input_schema?: { properties?: unknown } })
      .input_schema?.properties;
    if (typeof name !== 'string' || !properties || typeof properties !== 'object') {
      continue;
    }
    map.set(name, new Set(Object.keys(properties as Record<string, unknown>)));
  }

  return map;
}

/**
 * 采集本次请求历史里已出现的 tool_use id。
 * 用于识别「模型复述历史」而非发起新调用，避免还原后重复执行工具。
 */
export function collectHistoryToolUseIds(messages: AnthropicRequest['messages']): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      continue;
    }
    for (const block of message.content) {
      if (block.type === 'tool_use' && block.id) {
        ids.add(block.id);
      } else if (block.type === 'tool_result' && block.tool_use_id) {
        ids.add(block.tool_use_id);
      }
    }
  }
  return ids;
}
/**
 * 把响应内容块里被模型模仿出来的文本工具调用还原成结构化 `tool_use`。
 *
 * 返回三个计数，调用方据此告警：
 * - `toolUseCount`：成功还原的条数；
 * - `replayedCount`：模型在复述历史而非发起新调用，刻意不还原；
 * - `unparsedCount`：形状像调用却解析不出来 —— 兜底网漏了一次，回合会退化成
 *   `end_turn`。这是「助手莫名停下」的直接证据，没有它只能靠翻聊天记录复原现场。
 */
export function normalizeTextualToolUseBlocks(
  blocks: AnthropicResponseContent[],
  historyToolUseIds?: Set<string>,
  toolInputKeys?: ReadonlyMap<string, ReadonlySet<string>>,
): {
  content: AnthropicResponseContent[];
  toolUseCount: number;
  replayedCount: number;
  unparsedCount: number;
} {
  const next: AnthropicResponseContent[] = [];
  let toolUseCount = 0;
  let replayedCount = 0;
  let unparsedCount = 0;

  for (const block of blocks) {
    if (block.type !== 'text') {
      next.push(block);
      continue;
    }

    const convertedParts: AnthropicResponseContent[] = [];
    const pendingText: string[] = [];
    let converted = false;

    const flushText = () => {
      const text = pendingText.join('\n').trim();
      if (text) {
        convertedParts.push({ type: 'text', text });
      }
      pendingText.length = 0;
    };

    for (const line of block.text.split(/\r?\n/)) {
      const toolUse = parseTextualToolUseLine(line, toolInputKeys);
      if (!toolUse) {
        // 形状像调用却没解析出来 = 兜底网漏了一次，回合会退化成 end_turn。
        // 单独计数并告警，否则用户只会看到"助手莫名停下"，无从诊断。
        if (TEXTUAL_TOOL_LINE_SHAPE.test(line.trim())) {
          unparsedCount += 1;
        }
        pendingText.push(line);
        continue;
      }

      // id 已在本次请求历史里出现 = 模型在复述，不是新调用。
      if (toolUse.type === 'tool_use' && historyToolUseIds?.has(toolUse.id)) {
        replayedCount += 1;
        pendingText.push(line);
        continue;
      }

      flushText();
      convertedParts.push(toolUse);
      toolUseCount += 1;
      converted = true;
    }

    if (!converted) {
      next.push(block);
      continue;
    }

    flushText();
    next.push(...convertedParts);
  }

  return { content: next, toolUseCount, replayedCount, unparsedCount };
}

/**
 * 还原单行文本工具调用。
 *
 * 支持两种格式：
 * - `Previous assistant tool request: name=X id=Y input_json={...}`（Deno 侧 sanitize 产出）
 * - `[tool_use:X] id=Y input={...}`（message-format 的转录格式，也是 Sider 契约格式）
 */
export function parseTextualToolUseLine(
  line: string,
  toolInputKeys?: ReadonlyMap<string, ReadonlySet<string>>,
): AnthropicResponseContent | undefined {
  const trimmed = line.trim();
  const match = trimmed.match(
    /^Previous assistant tool request:\s*name=(\S+)\s+id=(\S+)\s+input_json=(.+)$/,
  ) ||
    trimmed.match(/^\[tool_use:([^\]]+)\]\s+id=([^\s]+)\s+input=(.+)$/);
  if (!match) {
    return undefined;
  }

  const name = match[1]?.trim();
  const id = match[2]?.trim();
  const inputText = match[3]?.trim();
  if (!name || !id || !inputText?.startsWith('{')) {
    return undefined;
  }

  try {
    const input = parseLooseToolInputJson(inputText, toolInputKeys?.get(name));
    if (!input) {
      return undefined;
    }
    return {
      type: 'tool_use',
      id,
      name,
      input: asRecord(input),
    };
  } catch {
    return undefined;
  }
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

/**
 * 注入给 Sider 的工具契约（Max 策略）。
 *
 * 原文来自 `deno/tools/probe-sider-tool-loop.ts` 的 `contract()`，一字未改——
 * 那是实测验证过的措辞（sonnet-5：单轮 5/5、带引号命令 5/5、无需工具时不乱调
 * 5/5、结果续轮不重复调 5/5、15 工具大 schema 5/5）。改措辞等于让那批实测失效，
 * 要改就得重跑 `deno task probe:sider` 的工具循环套件。
 *
 * 三个规则各有来历，都不是凑数的：
 * - 「一次只发一个调用」：多调用并发的还原与配对没验证过；
 * - 「单行紧凑 JSON」：解析器按行拆，跨行的 input 必然还原失败；
 * - 「不需要工具就正常作答、绝不输出那一行」：这条撑起了「无需工具时不乱调」，
 *   也是 Max 下「纯文本回答不算失败」这个判据成立的前提。
 *
 * 工具清单用完整 `JSON.stringify` 序列化，不做截断——probe 的 5/5 正是在完整
 * input_schema 下取得的。体量若因此超限，交给自适应限流器从 603 反馈里学，
 * 不在这里靠猜去砍。
 */
export function buildToolContract(tools: AnthropicRequest['tools']): string {
  return `You have access to these tools:

${JSON.stringify(tools ?? [])}

To call a tool, output a line in EXACTLY this format, on its own line, nothing after it:
[tool_use:ToolName] id=call_<random> input={<compact JSON matching input_schema>}

Rules:
- Emit at most one tool call per reply.
- input must be valid compact JSON on a single line.
- If no tool is needed, just answer normally and never emit that line.`;
}

export interface ToolRestoreResult {
  content: AnthropicResponseContent[];
  toolUseCount: number;
  /**
   * 形状像调用却解析不出来的行数。
   *
   * Max 策略据此判定「Sider 这轮没接住」并 fallback 到 DeepSeek。判据必须是
   * **形状像却没解析出来**，而不是「没有 tool_use」——契约明确允许模型在不需要
   * 工具时直接作答，probe 实测这种情况占 5/5，把它判成失败会把正常回答也兜底掉。
   */
  unparsedCount: number;
  replayedCount: number;
}

/**
 * 从一段纯文本里还原工具调用，供 Sider 通道使用。
 *
 * 与 DeepSeek 通道共用同一个解析器：转录格式、契约格式、解析格式三者同构，
 * 任何一处改动都要同步另外两处。
 */
export function restoreToolUseFromText(
  text: string,
  request: AnthropicRequest,
): ToolRestoreResult {
  return normalizeTextualToolUseBlocks(
    [{ type: 'text', text }],
    collectHistoryToolUseIds(request.messages),
    collectToolInputKeys(request.tools),
  );
}
