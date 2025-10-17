#!/usr/bin/env bun
/**
 * 测试动态模型映射功能
 */

import { ModelMapper } from '../src/utils/model-mapper';

const BASE_URL = process.env.ANTHROPIC_BASE_URL || 'https://api.oaipro.com';
const API_KEY = process.env.ANTHROPIC_API_KEY || '';

if (!API_KEY) {
  console.error('❌ 错误: ANTHROPIC_API_KEY 未设置');
  process.exit(1);
}

console.log('╭────────────────🧪 测试动态模型映射────────────────╮');
console.log(`│  Base URL: ${BASE_URL.padEnd(38)} │`);
console.log(`│  API Key: ${API_KEY.substring(0, 20)}...${' '.repeat(17)} │`);
console.log('╰────────────────────────────────────────────────────╯\n');

// 测试场景
const testCases = [
  // Claude 4.5 系列
  { input: 'claude-4.5-sonnet', expected: 'claude-sonnet-4-5-20250929' },
  { input: 'claude-4-5-sonnet', expected: 'claude-sonnet-4-5-20250929' },
  { input: 'claude-sonnet-4.5', expected: 'claude-sonnet-4-5-20250929' },

  // Claude 3.5 系列
  { input: 'claude-3.5-sonnet', expected: 'claude-3-5-sonnet-20241022' },
  { input: 'claude-3-5-sonnet-latest', expected: 'claude-3-5-sonnet-20241022' },

  // Claude 3 系列
  { input: 'claude-3-5-sonnet-20241022', expected: 'claude-3-5-sonnet-20241022' },
  { input: 'claude-3-opus-20240229', expected: 'claude-3-opus-20240229' },
  { input: 'claude-3-haiku-20240307', expected: 'claude-3-haiku-20240307' },

  // Claude Haiku 4.5
  { input: 'claude-haiku-4.5', expected: 'claude-haiku-4-5-20251001' },
];

async function testDynamicMapping() {
  console.log('🚀 开始测试动态模型映射...\n');

  const mapper = new ModelMapper(BASE_URL, API_KEY);

  // 测试初始化
  console.log('━━━ 阶段 1: 初始化映射器 ━━━');
  const startTime = Date.now();
  await mapper.initialize();
  const initTime = Date.now() - startTime;
  console.log(`✅ 初始化完成 (${initTime}ms)`);

  const stats = mapper.getStats();
  console.log('📊 统计信息:', stats);
  console.log('');

  // 测试模型映射
  console.log('━━━ 阶段 2: 测试模型映射 ━━━\n');

  const results: { input: string; output: string; expected: string; match: boolean; time: number }[] = [];

  for (const testCase of testCases) {
    const mapStart = Date.now();
    const mapped = await mapper.mapModel(testCase.input);
    const mapTime = Date.now() - mapStart;

    const match = mapped === testCase.expected;
    results.push({
      input: testCase.input,
      output: mapped,
      expected: testCase.expected,
      match,
      time: mapTime,
    });

    const icon = match ? '✅' : '⚠️ ';
    console.log(
      `${icon} ${testCase.input.padEnd(35)} → ${mapped.padEnd(35)} (${mapTime}ms)`
    );
  }

  console.log('');

  // 测试缓存
  console.log('━━━ 阶段 3: 测试映射缓存 ━━━\n');
  const cacheTests = ['claude-4.5-sonnet', 'claude-3.5-sonnet', 'claude-3-opus-20240229'];

  for (const model of cacheTests) {
    const cacheStart = Date.now();
    await mapper.mapModel(model);
    const cacheTime = Date.now() - cacheStart;
    console.log(`🔥 ${model.padEnd(35)} (缓存: ${cacheTime}ms)`);
  }

  console.log('');

  // 总结
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📊 测试总结');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const passed = results.filter(r => r.match).length;
  const total = results.length;
  const successRate = ((passed / total) * 100).toFixed(1);

  console.log(`总测试数: ${total}`);
  console.log(`✅ 通过: ${passed}`);
  console.log(`❌ 失败: ${total - passed}`);
  console.log(`成功率: ${successRate}%`);

  const avgTime = results.reduce((sum, r) => sum + r.time, 0) / results.length;
  console.log(`平均映射时间: ${avgTime.toFixed(2)}ms`);

  console.log('\n📋 详细结果:');
  results.forEach(r => {
    const icon = r.match ? '✅' : '❌';
    console.log(`${icon} ${r.input.padEnd(30)} → ${r.output.padEnd(30)} (${r.time}ms)`);
    if (!r.match) {
      console.log(`   预期: ${r.expected}`);
    }
  });

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // 显示可用的 Claude 模型
  const claudeModels = mapper.getAvailableClaudeModels();
  if (claudeModels.length > 0) {
    console.log('✨ 可用的 Claude 模型:');
    claudeModels.slice(0, 15).forEach(model => console.log(`   - ${model}`));
    if (claudeModels.length > 15) {
      console.log(`   ... 还有 ${claudeModels.length - 15} 个模型`);
    }
    console.log('');
  }

  // 最终统计
  const finalStats = mapper.getStats();
  console.log('📈 最终统计:');
  console.log(`   已初始化: ${finalStats.initialized}`);
  console.log(`   缓存映射数: ${finalStats.cachedMappings}`);
  console.log(`   可用模型数: ${finalStats.availableModels}`);
  console.log(`   Claude 模型数: ${finalStats.claudeModels}`);

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  if (passed === total) {
    console.log('🎉 所有测试通过! 动态模型映射功能正常!');
    return 0;
  } else {
    console.log(`⚠️  ${total - passed} 个测试失败`);
    return 1;
  }
}

testDynamicMapping()
  .then(code => process.exit(code))
  .catch(error => {
    console.error('❌ 测试异常:', error);
    process.exit(1);
  });
