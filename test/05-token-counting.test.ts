/**
 * Token 计数测试
 * 测试 /v1/messages/count_tokens 端点
 */


const API_BASE_URL = 'http://localhost:4141';
const AUTH_TOKEN = 'your-custom-auth-token-here';
interface TestResult {
  name: string;
  passed: boolean;
  duration: number;
  error?: string;
  details?: any;
}

async function testBasicTokenCounting(): Promise<TestResult> {
  const startTime = Date.now();
  const testName = 'Token 计数测试 - 基础';

  try {
    console.log(`\n🧪 运行测试: ${testName}`);

    const requestBody = {
      model: 'claude-3.7-sonnet',
      messages: [
        {
          role: 'user',
          content: 'Hello, how are you?'
        }
      ]
    };

    console.log('📤 计数内容:', JSON.stringify(requestBody, null, 2));

    const response = await fetch(`${API_BASE_URL}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    const duration = Date.now() - startTime;

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const data = await response.json();

    console.log('✅ 响应状态:', response.status);
    console.log('📦 响应数据:', JSON.stringify(data, null, 2));

    // 验证响应格式
    if (typeof data.input_tokens !== 'number') {
      throw new Error('响应缺少 input_tokens 字段');
    }

    console.log('🔢 Token 统计:');
    console.log('   输入 tokens:', data.input_tokens);

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

async function testLongTextTokenCounting(): Promise<TestResult> {
  const startTime = Date.now();
  const testName = 'Token 计数测试 - 长文本';

  try {
    console.log(`\n🧪 运行测试: ${testName}`);

    const longText = `
人工智能（Artificial Intelligence，简称 AI）是计算机科学的一个分支，
它企图了解智能的实质，并生产出一种新的能以人类智能相似的方式做出反应的智能机器。
该领域的研究包括机器人、语言识别、图像识别、自然语言处理和专家系统等。
人工智能从诞生以来，理论和技术日益成熟，应用领域���不断扩大，
可以设想，未来人工智能带来的科技产品，将会是人类智慧的"容器"。
人工智能可以对人的意识、思维的信息过程的模拟。
人工智能不是人的智能，但能像人那样思考、也可能超过人的智能。
`.trim();

    const requestBody = {
      model: 'claude-3.7-sonnet',
      messages: [
        {
          role: 'user',
          content: longText
        }
      ]
    };

    console.log('📤 计数长文本（', longText.length, '字符）...');

    const response = await fetch(`${API_BASE_URL}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    const duration = Date.now() - startTime;

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const data = await response.json();

    console.log('✅ 响应状态:', response.status);
    console.log('🔢 Token 统计:');
    console.log('   输入 tokens:', data.input_tokens);
    console.log('   字符数:', longText.length);
    console.log('   Token/字符比:', (data.input_tokens / longText.length).toFixed(3));

    return {
      name: testName,
      passed: true,
      duration,
      details: {
        inputTokens: data.input_tokens,
        characterCount: longText.length,
        ratio: data.input_tokens / longText.length,
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

async function testMultiMessageTokenCounting(): Promise<TestResult> {
  const startTime = Date.now();
  const testName = 'Token 计数测试 - 多轮对话';

  try {
    console.log(`\n🧪 运行测试: ${testName}`);

    const requestBody = {
      model: 'claude-3.7-sonnet',
      messages: [
        {
          role: 'user',
          content: '什么是 API？'
        },
        {
          role: 'assistant',
          content: 'API 是应用程序编程接口（Application Programming Interface）的缩写。'
        },
        {
          role: 'user',
          content: '能举个例子吗？'
        }
      ]
    };

    console.log('📤 计数多轮对话（', requestBody.messages.length, '条消息）...');

    const response = await fetch(`${API_BASE_URL}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    const duration = Date.now() - startTime;

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const data = await response.json();

    console.log('✅ 响应状态:', response.status);
    console.log('🔢 Token 统计:');
    console.log('   输入 tokens:', data.input_tokens);
    console.log('   消息数:', requestBody.messages.length);

    return {
      name: testName,
      passed: true,
      duration,
      details: {
        inputTokens: data.input_tokens,
        messageCount: requestBody.messages.length,
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

async function testTokenCountingWithSystemPrompt(): Promise<TestResult> {
  const startTime = Date.now();
  const testName = 'Token 计数测试 - ��含 system prompt';

  try {
    console.log(`\n🧪 运行测试: ${testName}`);

    const requestBody = {
      model: 'claude-3.7-sonnet',
      system: '你是一个友好的助手，请用中文回答问题。',
      messages: [
        {
          role: 'user',
          content: '你好！'
        }
      ]
    };

    console.log('📤 计数包含 system prompt 的请求...');

    const response = await fetch(`${API_BASE_URL}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    const duration = Date.now() - startTime;

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const data = await response.json();

    console.log('✅ 响应状态:', response.status);
    console.log('🔢 Token 统计:');
    console.log('   输入 tokens:', data.input_tokens);
    console.log('   (包含 system prompt)');

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

async function testInvalidTokenCountRequest(): Promise<TestResult> {
  const startTime = Date.now();
  const testName = 'Token 计数测试 - 无效请求';

  try {
    console.log(`\n🧪 运行测试: ${testName}`);

    const requestBody = {
      // 缺少 model 字段
      messages: [
        {
          role: 'user',
          content: 'test'
        }
      ]
    };

    const response = await fetch(`${API_BASE_URL}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    const duration = Date.now() - startTime;

    if (response.status === 400) {
      console.log('✅ 正确返回 400 Bad Request');
      const errorData = await response.json();
      console.log('📦 错误响应:', JSON.stringify(errorData, null, 2));

      return {
        name: testName,
        passed: true,
        duration,
        details: { status: 400, error: errorData },
      };
    } else {
      throw new Error(`期望返回 400，实际返回 ${response.status}`);
    }
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
  console.log('🚀 开始 Token 计数测试...');
  console.log('📍 API 地址:', API_BASE_URL);
  console.log('='.repeat(60));

  const results: TestResult[] = [];

  // 运行测试
  results.push(await testBasicTokenCounting());
  results.push(await testLongTextTokenCounting());
  results.push(await testMultiMessageTokenCounting());
  results.push(await testTokenCountingWithSystemPrompt());
  results.push(await testInvalidTokenCountRequest());

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
