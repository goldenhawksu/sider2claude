/**
 * 健康检查测试
 * 测试 API 基础可用性
 */

import { API_BASE_URL, AUTH_TOKEN, printTestConfig } from './test.config';

interface TestResult {
  name: string;
  passed: boolean;
  duration: number;
  error?: string;
  details?: any;
}

async function testHealthCheck(): Promise<TestResult> {
  const startTime = Date.now();
  const testName = '健康检查 - GET /health';

  try {
    console.log(`\n🧪 运行测试: ${testName}`);

    const response = await fetch(`${API_BASE_URL}/health`, {
      method: 'GET',
    });

    const duration = Date.now() - startTime;

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();

    console.log('✅ 响应状态:', response.status);
    console.log('📦 响应数据:', JSON.stringify(data, null, 2));

    // 验证响应格式
    if (!data || typeof data !== 'object') {
      throw new Error('响应格式不正确');
    }

    return {
      name: testName,
      passed: true,
      duration,
      details: data,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error('❌ 测试失败:', error);

    return {
      name: testName,
      passed: false,
      duration,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function testCORS(): Promise<TestResult> {
  const startTime = Date.now();
  const testName = 'CORS 配置检查';

  try {
    console.log(`\n🧪 运行测试: ${testName}`);

    const response = await fetch(`${API_BASE_URL}/health`, {
      method: 'OPTIONS',
      headers: {
        'Origin': 'http://localhost:3000',
        'Access-Control-Request-Method': 'POST',
      },
    });

    const duration = Date.now() - startTime;

    const corsHeaders = {
      'access-control-allow-origin': response.headers.get('access-control-allow-origin'),
      'access-control-allow-methods': response.headers.get('access-control-allow-methods'),
      'access-control-allow-headers': response.headers.get('access-control-allow-headers'),
    };

    console.log('✅ CORS Headers:', JSON.stringify(corsHeaders, null, 2));

    return {
      name: testName,
      passed: true,
      duration,
      details: corsHeaders,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error('❌ 测试失败:', error);

    return {
      name: testName,
      passed: false,
      duration,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// 运行所有测试
async function runAllTests() {
  console.log('🚀 开始健康检查测试...');
  printTestConfig();
  console.log('=' .repeat(60));

  const results: TestResult[] = [];

  // 运行测试
  results.push(await testHealthCheck());
  results.push(await testCORS());

  // 输出总结
  console.log('\n' + '='.repeat(60));
  console.log('📊 测试总结:');
  console.log('='.repeat(60));

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

  results.forEach(result => {
    const icon = result.passed ? '✅' : '❌';
    console.log(`${icon} ${result.name} (${result.duration}ms)`);
    if (result.error) {
      console.log(`   错误: ${result.error}`);
    }
  });

  console.log('\n总计:');
  console.log(`  通过: ${passed}/${results.length}`);
  console.log(`  失败: ${failed}/${results.length}`);
  console.log(`  总耗时: ${totalDuration}ms`);

  // 返回退出码
  process.exit(failed > 0 ? 1 : 0);
}

// 执行测试
runAllTests().catch(console.error);
