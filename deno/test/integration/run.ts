/**
 * 集成回归测试入口。
 *
 * 用法：
 *   deno task test:e2e                # 跑全部套件
 *   deno task test:e2e 05 06          # 只跑指定套件
 *   E2E_BASE_URL=https://... deno task test:e2e
 *
 * 退出码：只有 fail > 0 才非零。upstream（外部依赖受限）不算失败，
 * 但会在报告里单列，避免上游配额波动把回归门禁刷红。
 */

import { type CaseResult, createContext, runSuite, type Suite } from './harness.ts';
import { maskToken } from './config.ts';

import { suite as infrastructure } from './suites/01-infrastructure.ts';
import { suite as modelCatalog } from './suites/02-model-catalog.ts';
import { suite as messagesBasic } from './suites/03-messages-basic.ts';
import { suite as messagesStreaming } from './suites/04-messages-streaming.ts';
import { suite as toolCalling } from './suites/05-tool-calling.ts';
import { suite as claudeCodeAgent } from './suites/06-claude-code-agent.ts';
import { suite as protocolOpenAI } from './suites/07-protocol-openai.ts';
import { suite as protocolGemini } from './suites/08-protocol-gemini.ts';
import { suite as legacyComplete } from './suites/09-legacy-complete.ts';
import { suite as authErrors } from './suites/10-auth-errors.ts';

const ALL_SUITES: Suite[] = [
  infrastructure,
  modelCatalog,
  messagesBasic,
  messagesStreaming,
  toolCalling,
  claudeCodeAgent,
  protocolOpenAI,
  protocolGemini,
  legacyComplete,
  authErrors,
];

const selected = Deno.args.filter((arg) => !arg.startsWith('-'));
const suites = selected.length
  ? ALL_SUITES.filter((s) => selected.includes(s.id) || selected.includes(s.title))
  : ALL_SUITES;

if (!suites.length) {
  console.error(`未匹配到套件：${selected.join(', ')}`);
  console.error(`可选：${ALL_SUITES.map((s) => `${s.id}(${s.title})`).join(', ')}`);
  Deno.exit(2);
}

const ctx = createContext();

console.log('Sider2Claude 集成回归测试');
console.log('='.repeat(78));
console.log(`目标实例   ${ctx.config.baseUrl}`);
console.log(`认证 Token ${maskToken(ctx.config.authToken)}`);
console.log(`对话模型   live=${ctx.config.liveModel}`);
console.log(`CC 模型    sonnet=${ctx.config.claudeCodeSonnet} opus=${ctx.config.claudeCodeOpus}`);
console.log(`套件       ${suites.map((s) => s.id).join(', ')}`);

await assertReachable();

const startedAt = new Date();
const results: CaseResult[] = [];
for (const suite of suites) {
  results.push(...await runSuite(suite, ctx));
}
const elapsedMs = Date.now() - startedAt.getTime();

const pass = results.filter((r) => r.outcome === 'pass').length;
const fail = results.filter((r) => r.outcome === 'fail').length;
const upstream = results.filter((r) => r.outcome === 'upstream').length;

console.log('\n' + '='.repeat(78));
console.log(`总计 ${results.length} 项：通过 ${pass}｜失败 ${fail}｜上游受限 ${upstream}｜耗时 ${(elapsedMs / 1000).toFixed(1)}s`);

console.log('\n分组统计');
console.log('| 套件 | 用例 | 通过 | 失败 | 上游受限 | 耗时 |');
console.log('|---|---|---|---|---|---|');
for (const suite of suites) {
  const rows = results.filter((r) => r.suiteId === suite.id);
  if (!rows.length) continue;
  const ms = rows.reduce((sum, r) => sum + r.ms, 0);
  console.log(
    `| ${suite.id} ${suite.title} | ${rows.length} | ${rows.filter((r) => r.outcome === 'pass').length} | ` +
      `${rows.filter((r) => r.outcome === 'fail').length} | ${rows.filter((r) => r.outcome === 'upstream').length} | ${(ms / 1000).toFixed(1)}s |`,
  );
}

if (fail) {
  console.log('\n失败项（本服务问题）');
  for (const r of results.filter((r) => r.outcome === 'fail')) {
    console.log(`  ✗ [${r.suiteId}] ${r.name}\n      ${r.detail}`);
  }
}

if (upstream) {
  console.log('\n上游受限项（外部依赖，非本服务问题）');
  for (const r of results.filter((r) => r.outcome === 'upstream')) {
    console.log(`  ~ [${r.suiteId}] ${r.name}\n      ${r.detail}`);
  }
}

await writeReport();

Deno.exit(fail > 0 ? 1 : 0);

/** 先探活，避免把"服务没起"报成一堆用例失败。 */
async function assertReachable(): Promise<void> {
  try {
    const res = await fetch(`${ctx.config.baseUrl}/health`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`health 返回 HTTP ${res.status}`);
    const body = await res.json();
    console.log(`实例状态   ${body.status} (${body.version})`);
    console.log('='.repeat(78));
  } catch (error) {
    console.error(`\n无法连接目标实例 ${ctx.config.baseUrl}`);
    console.error(`原因：${error instanceof Error ? error.message : String(error)}`);
    console.error('请先启动服务（deno task start），或用 E2E_BASE_URL 指向已部署实例。');
    Deno.exit(2);
  }
}

async function writeReport(): Promise<void> {
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const path = `${ctx.config.reportDir}/e2e-${stamp}.md`;

  const lines = [
    `# Sider2Claude 集成回归测试报告`,
    '',
    `- 开始时间：${startedAt.toISOString()}`,
    `- 目标实例：${ctx.config.baseUrl}`,
    `- 总耗时：${(elapsedMs / 1000).toFixed(1)}s`,
    `- 结果：通过 ${pass}｜失败 ${fail}｜上游受限 ${upstream}（共 ${results.length} 项）`,
    '',
    '## 分组统计',
    '',
    '| 套件 | 用例 | 通过 | 失败 | 上游受限 | 耗时 |',
    '|---|---|---|---|---|---|',
  ];

  for (const suite of suites) {
    const rows = results.filter((r) => r.suiteId === suite.id);
    if (!rows.length) continue;
    const ms = rows.reduce((sum, r) => sum + r.ms, 0);
    lines.push(
      `| ${suite.id} ${suite.title} | ${rows.length} | ${rows.filter((r) => r.outcome === 'pass').length} | ` +
        `${rows.filter((r) => r.outcome === 'fail').length} | ${rows.filter((r) => r.outcome === 'upstream').length} | ${(ms / 1000).toFixed(1)}s |`,
    );
  }

  lines.push('', '## 逐项结果', '');
  let currentSuite = '';
  for (const r of results) {
    if (r.suiteId !== currentSuite) {
      currentSuite = r.suiteId;
      lines.push('', `### ${r.suiteId} ${r.suiteTitle}`, '', '| 用例 | 结果 | 耗时 | 实测细节 |', '|---|---|---|---|');
    }
    const mark = r.outcome === 'pass' ? '通过' : r.outcome === 'upstream' ? '上游受限' : '失败';
    lines.push(`| ${r.name} | ${mark} | ${r.ms}ms | ${r.detail.replace(/\|/g, '\\|')} |`);
  }

  try {
    await Deno.mkdir(ctx.config.reportDir, { recursive: true });
    await Deno.writeTextFile(path, lines.join('\n') + '\n');
    console.log(`\n报告已写入 ${path}`);
  } catch (error) {
    console.warn(`\n报告写入失败（不影响测试结果）：${error instanceof Error ? error.message : error}`);
  }
}
