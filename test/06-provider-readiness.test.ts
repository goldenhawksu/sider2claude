/**
 * OpenClaw provider 就绪性回归测试。
 *
 * 覆盖生产验证中暴露的关键风险：
 * - dummy token 不能绕过鉴权并消耗上游额度。
 * - 普通多轮 Anthropic messages 请求必须保留历史上下文。
 * - 强制 tool_choice 不能导致 DeepSeek 上游 400/服务端 500。
 */

import { API_BASE_URL, AUTH_TOKEN } from './test.config';

interface TestResult {
  name: string;
  passed: boolean;
  duration: number;
  error?: string;
  details?: any;
}

async function postMessages(token: string, body: Record<string, unknown>): Promise<Response> {
  return await fetch(`${API_BASE_URL}/v1/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
}

async function testDummyTokenRejected(): Promise<TestResult> {
  const startTime = Date.now();
  const testName = 'Provider 鉴权 - dummy token 默认拒绝';

  try {
    console.log(`\n🧪 运行测试: ${testName}`);

    const response = await postMessages('dummy', {
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'user', content: 'Reply exactly: SHOULD_NOT_RUN' }],
      max_tokens: 16,
    });

    const duration = Date.now() - startTime;
    const text = await response.text();
    console.log('✅ 响应状态:', response.status);
    console.log('📦 响应:', text);

    if (response.status !== 401) {
      throw new Error(`期望 dummy token 返回 401，实际返回 ${response.status}`);
    }

    return {
      name: testName,
      passed: true,
      duration,
      details: { status: response.status },
    };
  } catch (error) {
    return {
      name: testName,
      passed: false,
      duration: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function testInlineMessageHistory(): Promise<TestResult> {
  const startTime = Date.now();
  const testName = 'Provider 多轮历史 - 无 cid 的 messages 历史保留';
  const codeWord = `ULTRAMARINE-${Date.now().toString().slice(-6)}`;

  try {
    console.log(`\n🧪 运行测试: ${testName}`);

    const response = await postMessages(AUTH_TOKEN, {
      model: 'claude-sonnet-4.6',
      messages: [{
        role: 'user',
        content: `Remember this exact code word for the next turn: ${codeWord}.`,
      }, {
        role: 'assistant',
        content: `I will remember ${codeWord}.`,
      }, {
        role: 'user',
        content: 'What exact code word did I give you? Reply with only the code word.',
      }],
      max_tokens: 64,
    });

    const duration = Date.now() - startTime;
    const text = await response.text();
    console.log('✅ 响应状态:', response.status);
    console.log('📦 响应:', text);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text}`);
    }

    const data = JSON.parse(text);
    const answer = data.content
      ?.filter((block: any) => block.type === 'text')
      .map((block: any) => block.text)
      .join('\n') || '';

    if (!answer.includes(codeWord)) {
      throw new Error(`期望响应包含 code word ${codeWord}，实际为: ${answer}`);
    }

    return {
      name: testName,
      passed: true,
      duration,
      details: { codeWord, answer },
    };
  } catch (error) {
    return {
      name: testName,
      passed: false,
      duration: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function testForcedToolChoice(): Promise<TestResult> {
  const startTime = Date.now();
  const testName = 'Provider 工具调用 - tool_choice 强制工具兼容';

  try {
    console.log(`\n🧪 运行测试: ${testName}`);

    const response = await postMessages(AUTH_TOKEN, {
      model: 'claude-sonnet-4.6',
      messages: [{
        role: 'user',
        content:
          'Use the Bash tool to print the current working directory. Return only a tool call.',
      }],
      tools: [{
        name: 'Bash',
        description: 'Run a shell command',
        input_schema: {
          type: 'object',
          properties: {
            command: { type: 'string' },
            description: { type: 'string' },
          },
          required: ['command'],
        },
      }],
      tool_choice: { type: 'tool', name: 'Bash' },
      max_tokens: 256,
    });

    const duration = Date.now() - startTime;
    const text = await response.text();
    console.log('✅ 响应状态:', response.status);
    console.log('📦 响应:', text);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text}`);
    }

    const data = JSON.parse(text);
    const toolUse = data.content?.find((block: any) => block.type === 'tool_use');
    if (!toolUse || toolUse.name !== 'Bash') {
      throw new Error(`期望返回 Bash tool_use，实际响应为: ${text}`);
    }

    return {
      name: testName,
      passed: true,
      duration,
      details: {
        stopReason: data.stop_reason,
        toolName: toolUse.name,
        toolInput: toolUse.input,
      },
    };
  } catch (error) {
    return {
      name: testName,
      passed: false,
      duration: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runAllTests() {
  console.log('🚀 开始 OpenClaw provider 就绪性测试...');
  console.log('📍 API 地址:', API_BASE_URL);
  console.log('='.repeat(60));

  const results: TestResult[] = [];
  results.push(await testDummyTokenRejected());
  results.push(await testInlineMessageHistory());
  results.push(await testForcedToolChoice());

  console.log('\n' + '='.repeat(60));
  console.log('📊 测试总结:');
  console.log('='.repeat(60));

  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

  results.forEach((result) => {
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

  process.exit(failed > 0 ? 1 : 0);
}

runAllTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
