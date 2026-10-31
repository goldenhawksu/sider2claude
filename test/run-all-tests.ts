/**
 * 服务级黑盒集成测试统一入口。
 *
 * 这些测试会访问已经启动的 Sider2Claude 服务；默认测试 Bun 本地服务，
 * 可通过 TEST_ENV 切换到 deno-local 或 deno-deploy。
 */

import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTestConfig, printTestConfig } from './test.config';

interface FileResult {
  file: string;
  passed: boolean;
  durationMs: number;
  exitCode: number | null;
}

const testDir = dirname(fileURLToPath(import.meta.url));
const config = getTestConfig();
const requestedFiles = process.argv.slice(2);
const testFiles = resolveTestFiles();

console.log('🚀 Sider2Claude 服务级集成测试');
console.log(`⏰ 开始时间: ${new Date().toLocaleString()}`);
printTestConfig(config);
console.log(`📋 测试文件: ${testFiles.map((file) => basename(file)).join(', ')}`);

const results: FileResult[] = [];
const suiteStartedAt = Date.now();

for (const file of testFiles) {
  results.push(await runTestFile(file));
}

const totalDurationMs = Date.now() - suiteStartedAt;
const passed = results.filter((result) => result.passed).length;
const failed = results.length - passed;

console.log('\n' + '='.repeat(70));
console.log('📊 集成测试汇总');
console.log('='.repeat(70));

for (const result of results) {
  const icon = result.passed ? '✅' : '❌';
  console.log(`${icon} ${basename(result.file)} (${result.durationMs}ms)`);
}

console.log(`\n通过: ${passed}/${results.length}`);
console.log(`失败: ${failed}/${results.length}`);
console.log(`总耗时: ${totalDurationMs}ms`);
console.log(`结束时间: ${new Date().toLocaleString()}`);

writeReport();
process.exit(failed > 0 ? 1 : 0);

function writeReport(): void {
  const reportsDir = join(testDir, 'reports');
  mkdirSync(reportsDir, { recursive: true });

  const now = new Date();
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

  const lines = [
    `# Sider2Claude 集成测试报告 ${ts}`,
    '',
    `- 环境: ${config.environment}`,
    `- 目标: ${config.apiBaseUrl}`,
    `- 通过: ${passed}/${results.length}　失败: ${failed}/${results.length}`,
    `- 总耗时: ${totalDurationMs}ms`,
    '',
    '## 明细',
    '',
    '| 文件 | 结果 | 耗时(ms) | 退出码 |',
    '|---|---|---|---|',
    ...results.map((r) =>
      `| ${basename(r.file)} | ${r.passed ? 'PASS' : 'FAIL'} | ${r.durationMs} | ${r.exitCode ?? '-'} |`
    ),
    '',
  ];

  const reportPath = join(reportsDir, `integration-${ts}.md`);
  writeFileSync(reportPath, lines.join('\n'), 'utf8');
  console.log(`📄 报告已生成: ${reportPath}`);
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function resolveTestFiles(): string[] {
  if (requestedFiles.length > 0) {
    return requestedFiles.map((file) => join(testDir, file));
  }

  return readdirSync(testDir)
    .filter((file) => /^\d{2}-.+\.test\.ts$/.test(file))
    .sort()
    .map((file) => join(testDir, file));
}

async function runTestFile(file: string): Promise<FileResult> {
  console.log('\n' + '='.repeat(70));
  console.log(`🧪 运行测试文件: ${basename(file)}`);
  console.log('='.repeat(70));

  const startedAt = Date.now();
  const subprocess = Bun.spawn(['bun', 'run', file], {
    cwd: testDir,
    env: {
      ...process.env,
      TEST_ENV: config.environment,
      TEST_API_BASE_URL: config.apiBaseUrl,
      TEST_AUTH_TOKEN: config.authToken,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // 原样转发输出，同时保留尾部，失败时写成 GitHub Actions 注解：
  // 公开仓库的日志需要登录才能看，注解却能通过 API 读取，便于远程排查。
  // 注解内容经 GitHub 的 secret 打码，生产地址与 token 不会明文出现。
  const tail: string[] = [];
  const pump = async (stream: ReadableStream<Uint8Array>, sink: NodeJS.WriteStream) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true });
      sink.write(text);
      tail.push(...text.split('\n').filter((line) => line.trim()));
      if (tail.length > 200) tail.splice(0, tail.length - 200);
    }
  };
  await Promise.all([pump(subprocess.stdout, process.stdout), pump(subprocess.stderr, process.stderr)]);

  const exitCode = await subprocess.exited;
  if (exitCode !== 0 && process.env.GITHUB_ACTIONS === 'true') {
    const interesting = tail.filter((line) => /❌|⚠️|error|Error|失败|HTTP \d{3}/.test(line)).slice(-12);
    const message = (interesting.length ? interesting : tail.slice(-12))
      .map((line) => line.slice(0, 300))
      .join('\n')
      .replace(/%/g, '%25')
      .replace(/\r/g, '')
      .replace(/\n/g, '%0A');
    console.log(`::error title=${basename(file)} exit ${exitCode}::${message}`);
  }
  return {
    file,
    passed: exitCode === 0,
    durationMs: Date.now() - startedAt,
    exitCode,
  };
}
