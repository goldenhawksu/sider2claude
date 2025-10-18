/**
 * 流式响应测试
 * 测试 SSE (Server-Sent Events) 流式响应功能
 */

import { API_BASE_URL, AUTH_TOKEN, printTestConfig } from './test.config';
interface TestResult {
  name: string;
  passed: boolean;
  duration: number;
  error?: string;
  details?: any;
}

async function testStreamingResponse(): Promise<TestResult> {
  const startTime = Date.now();
  const testName = '流式响应测试 - stream: true';

  try {
    console.log(`\n🧪 运行测试: ${testName}`);

    const requestBody = {
      model: 'claude-3.7-sonnet',
      messages: [
        {
          role: 'user',
          content: '请用三句话介绍人工智能。'
        }
      ],
      max_tokens: 200,
      stream: true // 启用流式响应
    };

    console.log('📤 发送流式请求...');

    const response = await fetch(`${API_BASE_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    // 验证响应头
    const contentType = response.headers.get('Content-Type');
    console.log('✅ Content-Type:', contentType);

    if (!contentType?.includes('text/event-stream')) {
      throw new Error(`期望 Content-Type 包含 text/event-stream，实际: ${contentType}`);
    }

    // 读取流式响应
    if (!response.body) {
      throw new Error('响应没有 body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let fullText = '';
    let eventCount = 0;
    let chunkCount = 0;

    console.log('\n📡 接收流式数据:\n');

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        console.log('\n\n✅ 流结束');
        break;
      }

      chunkCount++;
      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (!line.trim() || line.startsWith(':')) {
          continue; // 跳过空行和注释
        }

        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();

          if (data === '[DONE]') {
            console.log('\n\n✅ 收到 [DONE] 标记');
            continue;
          }

          try {
            const event = JSON.parse(data);
            eventCount++;

            // 提取文本内容
            if (event.type === 'content_block_delta') {
              const text = event.delta?.text || '';
              if (text) {
                fullText += text;
                process.stdout.write(text); // 实时输出
              }
            } else if (event.type === 'content_block_start') {
              console.log(`[事件 ${eventCount}] content_block_start`);
            } else if (event.type === 'message_start') {
              console.log(`[事件 ${eventCount}] message_start`);
            } else if (event.type === 'message_delta') {
              console.log(`\n[事件 ${eventCount}] message_delta`);
            } else if (event.type === 'message_stop') {
              console.log(`\n[事件 ${eventCount}] message_stop`);
            }
          } catch (parseError) {
            console.error('\n⚠️ 解析 SSE 数据失败:', data);
          }
        }
      }
    }

    const duration = Date.now() - startTime;

    console.log('\n\n📊 流式统计:');
    console.log('   总 chunk 数:', chunkCount);
    console.log('   总事件数:', eventCount);
    console.log('   接收文本长度:', fullText.length, '字符');
    console.log('   总耗时:', duration, 'ms');

    if (!fullText || fullText.length === 0) {
      throw new Error('未接收到任何文本内容');
    }

    return {
      name: testName,
      passed: true,
      duration,
      details: {
        chunkCount,
        eventCount,
        textLength: fullText.length,
        text: fullText,
      },
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

async function testStreamingWithLongContent(): Promise<TestResult> {
  const startTime = Date.now();
  const testName = '长内容流式响应测试';

  try {
    console.log(`\n🧪 运行测试: ${testName}`);

    const requestBody = {
      model: 'claude-3.7-sonnet',
      messages: [
        {
          role: 'user',
          content: '请列举10个编程语言并简要介绍。'
        }
      ],
      max_tokens: 1000,
      stream: true
    };

    console.log('📤 发送长内容流式请求...');

    const response = await fetch(`${API_BASE_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    if (!response.body) {
      throw new Error('响应没有 body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let fullText = '';
    let startReceivingTime = 0;
    let firstChunkTime = 0;

    console.log('📡 接收中...');

    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      if (!startReceivingTime) {
        startReceivingTime = Date.now();
        firstChunkTime = startReceivingTime - startTime;
      }

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;

          try {
            const event = JSON.parse(data);
            if (event.type === 'content_block_delta') {
              const text = event.delta?.text || '';
              fullText += text;
            }
          } catch {}
        }
      }
    }

    const duration = Date.now() - startTime;

    console.log('✅ 接收完成');
    console.log('📊 性能指标:');
    console.log('   首字节延迟 (TTFB):', firstChunkTime, 'ms');
    console.log('   接收内容长度:', fullText.length, '字符');
    console.log('   总耗时:', duration, 'ms');

    // 验证内容质量
    const hasMultipleLanguages = /Python|Java|JavaScript|C\+\+|Go|Rust|Ruby|PHP|Swift|Kotlin/gi.test(fullText);

    if (!hasMultipleLanguages) {
      console.warn('⚠️ 警告: 响应内容可能不完整');
    }

    return {
      name: testName,
      passed: fullText.length > 100, // 至少要有实质内容
      duration,
      details: {
        firstChunkTime,
        textLength: fullText.length,
        hasMultipleLanguages,
        preview: fullText.substring(0, 200) + '...',
      },
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

async function testNonStreamingVsStreaming(): Promise<TestResult> {
  const startTime = Date.now();
  const testName = '非流式 vs 流式对比测试';

  try {
    console.log(`\n🧪 运行测试: ${testName}`);

    const baseRequest = {
      model: 'claude-3.7-sonnet',
      messages: [
        {
          role: 'user',
          content: '用一句话解释什么是 API。'
        }
      ],
      max_tokens: 100,
    };

    // 测试非流式
    console.log('\n📤 测试非流式响应...');
    const nonStreamStart = Date.now();

    const nonStreamResponse = await fetch(`${API_BASE_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ...baseRequest, stream: false }),
    });

    const nonStreamData = await nonStreamResponse.json();
    const nonStreamDuration = Date.now() - nonStreamStart;
    const nonStreamText = nonStreamData.content.find((c: any) => c.type === 'text')?.text || '';

    console.log('✅ 非流式耗时:', nonStreamDuration, 'ms');
    console.log('📝 非流式响应:', nonStreamText);

    // 等待 1 秒
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 测试流式
    console.log('\n📤 测试流式响应...');
    const streamStart = Date.now();

    const streamResponse = await fetch(`${API_BASE_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ...baseRequest, stream: true }),
    });

    const reader = streamResponse.body!.getReader();
    const decoder = new TextDecoder();
    let streamText = '';
    let firstChunkTime = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      if (!firstChunkTime) {
        firstChunkTime = Date.now() - streamStart;
      }

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;

          try {
            const event = JSON.parse(data);
            if (event.type === 'content_block_delta') {
              streamText += event.delta?.text || '';
            }
          } catch {}
        }
      }
    }

    const streamDuration = Date.now() - streamStart;

    console.log('✅ 流式耗时:', streamDuration, 'ms');
    console.log('   首字节延迟:', firstChunkTime, 'ms');
    console.log('📝 流式响应:', streamText);

    const duration = Date.now() - startTime;

    console.log('\n📊 对比结果:');
    console.log('   非流式总耗时:', nonStreamDuration, 'ms');
    console.log('   流式总耗时:', streamDuration, 'ms');
    console.log('   流式首字节:', firstChunkTime, 'ms');
    console.log('   流式优势:', firstChunkTime < nonStreamDuration ? '✅ 更快感知' : '⚠️ 无明显优势');

    return {
      name: testName,
      passed: true,
      duration,
      details: {
        nonStream: { duration: nonStreamDuration, text: nonStreamText },
        stream: { duration: streamDuration, firstChunk: firstChunkTime, text: streamText },
      },
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
  console.log('🚀 开始流式响应测试...');
  console.log('📍 API 地址:', API_BASE_URL);
  console.log('='.repeat(60));

  const results: TestResult[] = [];

  // 运行测试
  results.push(await testStreamingResponse());
  results.push(await testStreamingWithLongContent());
  results.push(await testNonStreamingVsStreaming());

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
