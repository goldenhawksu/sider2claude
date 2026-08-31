/**
 * A/B 对比：同一套代码 × 两个上游。
 *
 * 用法：
 *   AB_A=http://localhost:8000 AB_B=https://your-instance deno run  *     --allow-net --allow-read --allow-env deno/tools/ab-compare-upstreams.ts
 *
 * 场景：`DEEPSEEK_BASE_URL` 可以指向任意 Anthropic 兼容端，而各家行为差异很大
 * （实测见下表）。换上游或改动兼容层之后，用这个脚本确认**差异对调用方已经被
 * 抹平**——两侧不仅各自要对，还必须一致。
 *
 * 实测差异（2026-08，glm-5.3-flash vs deepseek-v4-flash-vision-exp）：
 *
 *   能力                     GLM              DeepSeek
 *   tool_choice tool(X)      200              400「Thinking mode does not support」
 *   tool_choice none         忽略，仍调工具    原生生效
 *   stop_sequences           截 thinking      完全符合规范
 *   thinking 吃预算阈值       256 仍失败        256 已正常（64 失败）
 *   thinking disabled        有效             有效
 *   budget_tokens            忽略             忽略
 *
 * 注意图片测试用**程序生成**的 PNG：手写的 base64 曾让 DeepSeek 以 400 拒绝而
 * GLM 接受，那是测试数据缺陷，会把上游对比污染成产品缺陷。
 */

const A = { name: "A", base: Deno.env.get("AB_A") ?? "http://localhost:8000" };
const B = {
  name: "B",
  base: Deno.env.get("AB_B") ?? "https://sider2claude.asu.deno.net",
};

const TOKEN = (await Deno.readTextFile("deno/.env")).split(/\r?\n/)
  .find((l) => l.startsWith("AUTH_TOKEN="))!.split("=")[1].trim();
const H = { "content-type": "application/json", "x-api-key": TOKEN };

async function call(base: string, body: unknown, timeoutMs = 120_000) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: H,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: r.status, j: await r.json().catch(() => ({})), ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, j: { _err: String(e) }, ms: Date.now() - t0 };
  }
}

const text = (j: any) =>
  (j?.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
const blocks = (j: any) => (j?.content ?? []).map((b: any) => b.type).join(",");
const toolUses = (j: any) => (j?.content ?? []).filter((b: any) => b.type === "tool_use");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 一个对照项：两边各跑一次，打印并判定行为是否一致。 */
async function compare(
  title: string,
  body: unknown,
  judge: (j: any) => { ok: boolean; note: string },
) {
  console.log(`\n${title}`);
  const results: Array<{ name: string; ok: boolean; note: string; ms: number }> = [];
  for (const target of [A, B]) {
    const { status, j, ms } = await call(target.base, body);
    const v = status === 200 ? judge(j) : { ok: false, note: `HTTP ${status}` };
    results.push({ name: target.name, ...v, ms });
    console.log(`  ${v.ok ? "✓" : "✗"} ${target.name.padEnd(16)} ${String(ms).padStart(5)}ms  ${v.note}`);
    await sleep(1500);
  }
  const consistent = results[0].ok === results[1].ok;
  if (!consistent) console.log(`  ⚠ 两侧行为不一致——调用方会因为换上游而看到不同结果`);
  return consistent && results.every((r) => r.ok);
}

const WEATHER = {
  name: "get_weather",
  description: "查询城市天气",
  input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
};
/** 生成合法的纯色 PNG。手写的 base64 曾让 DeepSeek 以 400 拒绝而 GLM 接受——
 *  那是测试数据缺陷，会把上游对比污染成产品缺陷。 */
function solidPng(w: number, h: number, r: number, g: number, b: number): string {
  const raw: number[] = [];
  for (let y = 0; y < h; y++) { raw.push(0); for (let x = 0; x < w; x++) raw.push(r, g, b); }
  const table: number[] = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  const crc32 = (buf: number[]) => { let c = 0xffffffff; for (const x of buf) c = table[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const chunk = (type: string, data: number[]) => { const t = [...type].map((c) => c.charCodeAt(0)); return [...be32(data.length), ...t, ...data, ...be32(crc32([...t, ...data]))]; };
  const z: number[] = [0x78, 0x01]; let off = 0;
  while (off < raw.length) { const len = Math.min(65535, raw.length - off); const last = off + len >= raw.length ? 1 : 0;
    z.push(last, len & 255, (len >> 8) & 255, ~len & 255, (~len >> 8) & 255);
    for (let i = 0; i < len; i++) z.push(raw[off + i]); off += len; }
  let a = 1, b2 = 0; for (const byte of raw) { a = (a + byte) % 65521; b2 = (b2 + a) % 65521; }
  z.push(...be32(((b2 << 16) | a) >>> 0));
  const png = [137,80,78,71,13,10,26,10, ...chunk("IHDR", [...be32(w), ...be32(h), 8, 2, 0, 0, 0]), ...chunk("IDAT", z), ...chunk("IEND", [])];
  let out = ""; for (const byte of png) out += String.fromCharCode(byte);
  return btoa(out);
}
const RED_PNG = solidPng(32, 32, 255, 0, 0);

console.log("═".repeat(78));
console.log("A/B 对比：同一套代码 × 两个上游");
console.log(`  A = ${A.name}  ${A.base}`);
console.log(`  B = ${B.name}  ${B.base}`);
console.log("═".repeat(78));

const verdicts: Array<[string, boolean]> = [];

verdicts.push(["小预算不出空响应", await compare(
  "【1】小预算 max_tokens=64（两家的 thinking 都会吃预算，阈值不同）",
  { model: "claude-fable-5", max_tokens: 64, messages: [{ role: "user", content: "什么是递归？" }] },
  (j) => {
    const t = text(j);
    return { ok: t.length > 0, note: `正文 ${t.length} 字 blocks=[${blocks(j)}] stop=${j.stop_reason}` };
  },
)]);

verdicts.push(["中预算 256", await compare(
  "【2】中预算 max_tokens=256（GLM 此处仍失败，DeepSeek 已正常——阈值必须各自学）",
  { model: "claude-fable-5", max_tokens: 256, messages: [{ role: "user", content: "什么是尾递归？" }] },
  (j) => {
    const t = text(j);
    return { ok: t.length > 0, note: `正文 ${t.length} 字 blocks=[${blocks(j)}]` };
  },
)]);

verdicts.push(["tool_choice none", await compare(
  "【3】tool_choice: none（GLM 完全忽略，DeepSeek 原生支持）",
  {
    model: "claude-haiku-4.5", max_tokens: 512, tools: [WEATHER],
    tool_choice: { type: "none" },
    messages: [{ role: "user", content: "北京天气怎么样？" }],
  },
  (j) => ({ ok: toolUses(j).length === 0, note: `tool_use=${toolUses(j).length} stop=${j.stop_reason}` }),
)]);

verdicts.push(["tool_choice tool", await compare(
  "【4】tool_choice: {type:'tool'}（DeepSeek 直接 400，必须由服务端绕开）",
  {
    model: "claude-haiku-4.5", max_tokens: 512, tools: [WEATHER],
    tool_choice: { type: "tool", name: "get_weather" },
    messages: [{ role: "user", content: "查一下上海的天气" }],
  },
  (j) => {
    const tu = toolUses(j);
    return { ok: tu.some((t: any) => t.name === "get_weather"), note: `tool_use=${tu.map((t: any) => t.name).join(",") || "无"}` };
  },
)]);

verdicts.push(["stop_sequences", await compare(
  "【5】stop_sequences（DeepSeek 原生符合规范，GLM 会截 thinking）",
  {
    model: "claude-fable-5", max_tokens: 512, stop_sequences: ["3"],
    messages: [{ role: "user", content: "只输出这几个字符，不要说别的：1 2 3 4 5" }],
  },
  (j) => ({
    ok: j.stop_reason === "stop_sequence" && j.stop_sequence === "3" && !text(j).includes("3"),
    note: `stop=${j.stop_reason} seq=${JSON.stringify(j.stop_sequence)} 正文=${JSON.stringify(text(j).slice(0, 16))}`,
  }),
)]);

verdicts.push(["视觉", await compare(
  "【6】视觉输入（两家都是 VLM）",
  {
    model: "claude-haiku-4.5", max_tokens: 800,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: RED_PNG } },
        { type: "text", text: "这张图是什么颜色？只答颜色名。" },
      ],
    }],
  },
  (j) => {
    const t = text(j);
    return { ok: /红|red/i.test(t), note: JSON.stringify(t.slice(0, 30)) };
  },
)]);

verdicts.push(["工具调用", await compare(
  "【7】常规工具调用（回归）",
  {
    model: "claude-haiku-4.5", max_tokens: 1024, tools: [WEATHER],
    messages: [{ role: "user", content: "广州天气怎么样？" }],
  },
  (j) => {
    const tu = toolUses(j);
    return { ok: tu[0]?.input?.city?.includes("广州"), note: `${tu[0]?.name}(${JSON.stringify(tu[0]?.input)})` };
  },
)]);

verdicts.push(["大预算保留 thinking", await compare(
  "【8】大预算应保留 thinking（学习不该波及）",
  { model: "claude-fable-5", max_tokens: 4096, messages: [{ role: "user", content: "用两句话解释闭包。" }] },
  (j) => ({ ok: blocks(j).includes("thinking"), note: `blocks=[${blocks(j)}] 正文 ${text(j).length} 字` }),
)]);

console.log("\n" + "═".repeat(78));
console.log("汇总（两侧行为一致且都正确才算通过）");
console.log("═".repeat(78));
for (const [name, ok] of verdicts) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
}
const passed = verdicts.filter(([, ok]) => ok).length;
console.log(`\n${passed}/${verdicts.length} 项在两个上游下表现一致`);
