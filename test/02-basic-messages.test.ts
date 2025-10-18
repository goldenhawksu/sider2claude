/**
 * 基础消息 API 测试
 * 测试 /v1/messages 端点的核心功能
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

async function testModelsEndpoint(): Promise<TestResult> {
  const startTime = Date.now();
  const testName = '模型列表 - GET /v1/models';

  try {
    console.log(`\n🧪 运行测试: ${testName}`);

    const response = await fetch(`${API_BASE_URL}/v1/models`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${AUTH_TOKEN}`,
      },
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
    if (!data.object || data.object !== 'list') {
      throw new Error('响应格式错误：缺少 object 字段');
    }

    if (!data.data || !Array.isArray(data.data)) {
      throw new Error('响应格式错误：data 字段不是数组');
    }

    console.log(`📊 找到 ${data.data.length} 个模型`);

    // 验证每个模型的格式
    for (const model of data.data) {
      if (!model.id || !model.object || model.object !== 'model') {
        throw new Error(`模型格式错误: ${JSON.stringify(model)}`);
      }
    }

    return {
      name: testName,
      passed: true,
      duration,
      details: {
        modelCount: data.data.length,
        models: data.data.map((m: any) => m.id),
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

async function testBasicMessage(): Promise<TestResult> {
  const startTime = Date.now();
  const testName = '基础消息请求 - POST /v1/messages';

  try {
    console.log(`\n🧪 运行测试: ${testName}`);

    const requestBody = {
      model: 'claude-3.7-sonnet',
      messages: [
        {
          role: 'user',
          content: '你好，请用一句话介绍你自己。'
        }
      ],
      max_tokens: 100,
      stream: false
    };

    console.log('📤 请求数据:', JSON.stringify(requestBody, null, 2));

    const response = await fetch(`${API_BASE_URL}/v1/messages`, {
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
    if (!data.id || !data.content || !Array.isArray(data.content)) {
      throw new Error('响应格式不符合 Anthropic API 规范');
    }

    // 验证内容
    const textContent = data.content.find((c: any) => c.type === 'text');
    if (!textContent || !textContent.text) {
      throw new Error('响应中没有文本内容');
    }

    console.log('💬 AI 回复:', textContent.text);

    // 验证会话信息 headers
    const conversationId = response.headers.get('X-Conversation-ID');
    console.log('🔑 会话 ID:', conversationId || '(未返回)');

    return {
      name: testName,
      passed: true,
      duration,
      details: {
        responseId: data.id,
        model: data.model,
        responseText: textContent.text,
        conversationId,
        usage: data.usage,
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

async function testDifferentModels(): Promise<TestResult> {
  const startTime = Date.now();
  const testName = '不同模型测试';

  try {
    console.log(`\n🧪 运行测试: ${testName}`);

    // 动态获取模型列表
    console.log('\n📥 获取模型列表...');
    const modelsResponse = await fetch(`${API_BASE_URL}/v1/models`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${AUTH_TOKEN}`,
      },
    });

    if (!modelsResponse.ok) {
      throw new Error(`无法获取模型列表: ${modelsResponse.status}`);
    }

    const modelsData = await modelsResponse.json();

    if (!modelsData.data || !Array.isArray(modelsData.data)) {
      throw new Error('模型列表格式错误');
    }

    const models = modelsData.data.map((m: any) => m.id);
    console.log(`✅ 获取到 ${models.length} 个模型:`, models.join(', '));

    // 限制测试数量，避免测试时间过长
    const modelsToTest = models.slice(0, 5);
    console.log(`\n🔍 测试前 ${modelsToTest.length} 个模型...`);

    const results: any[] = [];

    for (const model of modelsToTest) {
      console.log(`\n  测试模型: ${model}`);

      const requestBody = {
        model,
        messages: [{ role: 'user', content: '说"测试成功"' }],
        max_tokens: 50,
        stream: false
      };

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
        console.log(`  ⚠️ 模型 ${model} 失败: ${errorText}`);
        results.push({ model, success: false, error: errorText });
        continue;
      }

      const data = await response.json();
      const textContent = data.content.find((c: any) => c.type === 'text');

      console.log(`  ✅ 模型 ${model} 响应:`, textContent?.text || '(无内容)');
      results.push({ model, success: true, text: textContent?.text });
    }

    const duration = Date.now() - startTime;
    const allPassed = results.every(r => r.success);

    return {
      name: testName,
      passed: allPassed,
      duration,
      details: {
        totalModels: models.length,
        testedModels: modelsToTest.length,
        results
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

async function testAuthenticationRequired(): Promise<TestResult> {
  const startTime = Date.now();
  const testName = '认证测试 - 缺少 Token';

  try {
    console.log(`\n🧪 运行测试: ${testName}`);

    const requestBody = {
      model: 'claude-3.7-sonnet',
      messages: [{ role: 'user', content: 'test' }],
      max_tokens: 50
    };

    const response = await fetch(`${API_BASE_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // 故意不提供 Authorization header
      },
      body: JSON.stringify(requestBody),
    });

    const duration = Date.now() - startTime;

    if (response.status === 401) {
      console.log('✅ 正确返回 401 Unauthorized');
      const errorData = await response.json();
      console.log('📦 错误响应:', JSON.stringify(errorData, null, 2));

      return {
        name: testName,
        passed: true,
        duration,
        details: { status: 401, error: errorData },
      };
    } else {
      throw new Error(`期望返回 401，实际返回 ${response.status}`);
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

async function testInvalidRequest(): Promise<TestResult> {
  const startTime = Date.now();
  const testName = '无效请求测试';

  try {
    console.log(`\n🧪 运行测试: ${testName}`);

    const requestBody = {
      // 缺少必需的 model 字段
      messages: [{ role: 'user', content: 'test' }],
      max_tokens: 50
    };

    const response = await fetch(`${API_BASE_URL}/v1/messages`, {
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
  console.log('🚀 开始基础消息 API 测试...');
  console.log('📍 API 地址:', API_BASE_URL);
  console.log('🔑 认证 Token:', AUTH_TOKEN);
  console.log('='.repeat(60));

  const results: TestResult[] = [];

  // 运行测试（先测试模型列表端点）
  results.push(await testModelsEndpoint());
  results.push(await testBasicMessage());
  results.push(await testDifferentModels());
  results.push(await testAuthenticationRequired());
  results.push(await testInvalidRequest());

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
