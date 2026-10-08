import { getEnv } from '../../src/utils/env.ts';
const directory = Deno.cwd().replaceAll('\\', '/') + '/.runtime/controller-cli';
await Deno.mkdir(directory, { recursive: true });
const source = JSON.stringify(
  {
    images: Array.from(
      { length: 12 },
      (_, i) => ({
        id: i + 1,
        file_path: `assets/${i + 1}.png`,
        prompt: `中文引号"file_path"反斜杠\\换行\n😀第${i + 1}页`.repeat(16),
      }),
    ),
  },
  null,
  2,
);
await Deno.writeTextFile(`${directory}/source.json`, source);
const base = getEnv('E2E_BASE_URL', 'http://localhost:18000');
const runtimeLabel = getEnv('E2E_CLI_RUNTIME', 'deno');
const outfile = `${directory}/${runtimeLabel}-output-${crypto.randomUUID()}.json`;
const prompt =
  `只在${directory}目录内操作。先用Read读取${directory}/source.json，再用Write写入${outfile}。必须将源文件正文逐字复制，不改变任何字段、引号、反斜杠、换行或Unicode字符。收到Write成功结果后报告完成，不能提前声称完成。`;
const command = new Deno.Command(getEnv('CLAUDE_CODE_BIN', 'claude'), {
  cwd: directory,
  args: [
    '--safe-mode',
    '--setting-sources=',
    '--no-session-persistence',
    '--model',
    'claude-opus-5.5',
    '--tools',
    'Read,Write',
    '--allowedTools',
    'Read,Write',
    '--system-prompt',
    '你负责完成文件复制任务。所有工具由客户端实际执行。保留文件完整正文，不自行修改。只使用Read和Write。',
    '--output-format',
    'stream-json',
    '--verbose',
    '--print',
    prompt,
  ],
  env: {
    ANTHROPIC_BASE_URL: base,
    ANTHROPIC_API_KEY: getEnv('AUTH_TOKEN'),
    ANTHROPIC_AUTH_TOKEN: getEnv('AUTH_TOKEN'),
    CLAUDE_CONFIG_DIR: `${directory}/config`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  },
  stdout: 'piped',
  stderr: 'piped',
});
const started = Date.now();
const result = await command.output();
const stdout = new TextDecoder().decode(result.stdout),
  stderr = new TextDecoder().decode(result.stderr);
await Deno.writeTextFile(`${directory}/${runtimeLabel}-client-output.jsonl`, stdout);
await Deno.writeTextFile(`${directory}/${runtimeLabel}-client-error.log`, stderr);
let content = '';
try {
  content = await Deno.readTextFile(outfile);
} catch {}
const sourceBytes = await Deno.readFile(`${directory}/source.json`);
let outputBytes = new Uint8Array();
try {
  outputBytes = await Deno.readFile(outfile);
} catch {}
const byteExact = sourceBytes.length === outputBytes.length &&
  sourceBytes.every((value, index) => outputBytes[index] === value);
const events = stdout.split(/\r?\n/).flatMap((line) => {
  try {
    return [JSON.parse(line)];
  } catch {
    return [];
  }
});
const final = events.findLast((event) => event.type === 'result');
const calls = events.flatMap((event) =>
  (event.message?.content ?? []).filter((block: any) => block.type === 'tool_use')
);
const writes = calls.filter((call: any) => call.name === 'Write');
const writeSuccess = events.some((event) =>
  event.type === 'user' &&
  (event.message?.content ?? []).some((block: any) =>
    block.type === 'tool_result' && !block.is_error &&
    writes.some((call: any) => call.id === block.tool_use_id)
  )
);
let items = 0, parseError = '';
try {
  items = content ? JSON.parse(content).images.length : 0;
} catch (e) {
  parseError = String(e);
}
const report = {
  base,
  at: new Date().toISOString(),
  elapsedMs: Date.now() - started,
  exitCode: result.code,
  sourceChars: source.length,
  outputChars: content.length,
  exact: source === content,
  byteExact,
  items,
  parseError,
  resultError: final?.is_error,
  writeSuccess,
  toolUses: calls.map((block: any) => block.name),
};
await Deno.writeTextFile(
  `${directory}/${runtimeLabel}-verification.json`,
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report));
if (
  !report.byteExact ||
  !report.exact || report.items !== 12 || report.exitCode !== 0 || report.resultError ||
  !report.writeSuccess
) Deno.exit(1);
