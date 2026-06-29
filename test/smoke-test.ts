/**
 * 冒烟测试 — 零上游消耗的快速验证。
 *
 * 覆盖：健康检查、模型列表格式、CORS、认证保护、无效请求校验。
 * 不发送实质性对话请求，不消耗 Sider 或 DeepSeek 配额。
 *
 * 用法：
 *   bun run test/smoke-test.ts
 *   $env:TEST_ENV="deno-local"; bun run test/smoke-test.ts
 *   $env:TEST_ENV="deno-deploy"; $env:TEST_API_BASE_URL="https://..."; bun run test/smoke-test.ts
 */

import { API_BASE_URL, AUTH_TOKEN, getTestConfig, printTestConfig } from './test.config';

interface SmokeResult {
  name: string;
  passed: boolean;
  durationMs: number;
  error?: string;
  details?: unknown;
}

const results: SmokeResult[] = [];

function record(result: SmokeResult): void {
  results.push(result);
  const icon = result.passed ? '✅' : '❌';
  console.log(`  ${icon} ${result.name} (${result.durationMs}ms)`);
  if (result.error) {
    console.log(`    错误: ${result.error}`);
  }
}

// ── 测试用例 ──

async function testHealthEndpoint(): Promise<void> {
  const startedAt = Date.now();
  const name = '健康检查 GET /health';
  try {
    console.log(`\n🧪 ${name}`);
    const res = await fetch(`${API_BASE_URL}/health`);
    const durationMs = Date.now() - startedAt;

    if (res.status !== 200) {
      record({ name, passed: false, durationMs, error: `HTTP ${res.status}` });
      return;
    }

    const body = await res.json();
    if (!body || typeof body !== 'object') {
      record({ name, passed: false, durationMs, error: '响应不是 JSON 对象' });
      return;
    }

    record({ name, passed: true, durationMs, details: body });
  } catch (err) {
    record({ name, passed: false, durationMs: Date.now() - startedAt, error: String(err) });
  }
}

async function testCORS(): Promise<void> {
  const startedAt = Date.now();
  const name = 'CORS 配置 OPTIONS';
  try {
    console.log(`\n🧪 ${name}`);
    const res = await fetch(`${API_BASE_URL}/health`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:3000',
        'Access-Control-Request-Method': 'POST',
      },
    });
    const durationMs = Date.now() - startedAt;

    // 不强制要求特定状态码，OPTIONS 返回任何非 5xx 即可
    const ok = res.status < 500;
    record({
      name,
      passed: ok,
      durationMs,
      details: {
        status: res.status,
        allowOrigin: res.headers.get('access-control-allow-origin'),
        allowMethods: res.headers.get('access-control-allow-methods'),
      },
    });
  } catch (err) {
    record({ name, passed: false, durationMs: Date.now() - startedAt, error: String(err) });
  }
}

async function testModelsList(): Promise<void> {
  const startedAt = Date.now();
  const name = '模型列表 GET /v1/models';
  try {
    console.log(`\n🧪 ${name}`);
    const res = await fetch(`${API_BASE_URL}/v1/models`);
    const durationMs = Date.now() - startedAt;

    if (res.status !== 200) {
      record({ name, passed: false, durationMs, error: `HTTP ${res.status}` });
      return;
    }

    const body = await res.json();

    // Anthropic 模型列表格式
    if (!body || body.object !== 'list') {
      record({ name, passed: false, durationMs, error: '缺少 object: "list"' });
      return;
    }

    if (!Array.isArray(body.data)) {
      record({ name, passed: false, durationMs, error: 'data 不是数组' });
      return;
    }

    if (body.data.length === 0) {
      record({ name, passed: false, durationMs, error: '模型列表为空' });
      return;
    }

    // 验证每个模型的格式
    const invalidModels = body.data.filter((m: Record<string, unknown>) => !m.id || m.object !== 'model');
    if (invalidModels.length > 0) {
      record({
        name,
        passed: false,
        durationMs,
        error: `${invalidModels.length} 个模型格式无效 (缺少 id 或 object !== "model")`,
      });
      return;
    }

    const modelIds = body.data.map((m: Record<string, unknown>) => m.id);
    record({
      name,
      passed: true,
      durationMs,
      details: { count: body.data.length, models: modelIds },
    });
  } catch (err) {
    record({ name, passed: false, durationMs: Date.now() - startedAt, error: String(err) });
  }
}

async function testAuthRequired(): Promise<void> {
  const startedAt = Date.now();
  const name = '认证保护 — 无 token 返回 401';
  try {
    console.log(`\n🧪 ${name}`);
    const res = await fetch(`${API_BASE_URL}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-3.7-sonnet',
        messages: [{ role: 'user', content: 'test' }],
        max_tokens: 50,
      }),
    });
    const durationMs = Date.now() - startedAt;

    if (res.status !== 401) {
      record({ name, passed: false, durationMs, error: `期望 401, 实际 ${res.status}` });
      return;
    }

    const body = await res.json().catch(() => null);
    record({ name, passed: true, durationMs, details: body });
  } catch (err) {
    record({ name, passed: false, durationMs: Date.now() - startedAt, error: String(err) });
  }
}

async function testInvalidRequest(): Promise<void> {
  const startedAt = Date.now();
  const name = '请求校验 — 缺少 model 返回 400';
  try {
    console.log(`\n🧪 ${name}`);
    const res = await fetch(`${API_BASE_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'test' }],
        max_tokens: 50,
      }),
    });
    const durationMs = Date.now() - startedAt;

    if (res.status !== 400) {
      record({ name, passed: false, durationMs, error: `期望 400, 实际 ${res.status}` });
      return;
    }

    const body = await res.json().catch(() => null);
    record({ name, passed: true, durationMs, details: body });
  } catch (err) {
    record({ name, passed: false, durationMs: Date.now() - startedAt, error: String(err) });
  }
}

async function testNotFound(): Promise<void> {
  const startedAt = Date.now();
  const name = '404 处理 — 未知路径';
  try {
    console.log(`\n🧪 ${name}`);
    const res = await fetch(`${API_BASE_URL}/nonexistent-path`);
    const durationMs = Date.now() - startedAt;

    // 期望 404 或 405，至少不是 5xx 崩溃
    const ok = res.status === 404 || res.status === 405;
    record({
      name,
      passed: ok,
      durationMs,
      details: { status: res.status },
    });
  } catch (err) {
    record({ name, passed: false, durationMs: Date.now() - startedAt, error: String(err) });
  }
}

async function testTokenCountEndpoint(): Promise<void> {
  const startedAt = Date.now();
  const name = 'Token 计数端点 — 格式验证';
  try {
    console.log(`\n🧪 ${name}`);
    const res = await fetch(`${API_BASE_URL}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-3.7-sonnet',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });
    const durationMs = Date.now() - startedAt;

    if (res.status !== 200) {
      record({ name, passed: false, durationMs, error: `HTTP ${res.status}` });
      return;
    }

    const body = await res.json();
    if (typeof body.input_tokens !== 'number') {
      record({ name, passed: false, durationMs, error: '响应缺少 input_tokens (number)' });
      return;
    }

    record({ name, passed: true, durationMs, details: { input_tokens: body.input_tokens } });
  } catch (err) {
    record({ name, passed: false, durationMs: Date.now() - startedAt, error: String(err) });
  }
}

// ── 主入口 ──

async function main(): Promise<void> {
  const config = getTestConfig();

  console.log('🚀 Sider2Claude 冒烟测试');
  console.log(`⏰ ${new Date().toLocaleString()}`);
  printTestConfig(config);
  console.log('ℹ️  零上游消耗 — 仅验证服务基础可用性\n');

  // 按顺序运行（冒烟测试快速，不需要并行）
  await testHealthEndpoint();
  await testCORS();
  await testModelsList();
  await testAuthRequired();
  await testInvalidRequest();
  await testNotFound();
  await testTokenCountEndpoint();

  // ── 汇总 ──
  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  const totalMs = results.reduce((sum, r) => sum + r.durationMs, 0);

  console.log('\n' + '='.repeat(60));
  console.log('📊 冒烟测试汇总');
  console.log('='.repeat(60));
  for (const r of results) {
    const icon = r.passed ? '✅' : '❌';
    console.log(`${icon} ${r.name} (${r.durationMs}ms)`);
    if (r.error) console.log(`   ↳ ${r.error}`);
  }
  console.log(`\n通过: ${passed}/${results.length}  失败: ${failed}  总耗时: ${totalMs}ms`);
  console.log(`结束时间: ${new Date().toLocaleString()}`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('冒烟测试致命错误:', err);
  process.exit(1);
});
