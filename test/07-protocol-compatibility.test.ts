import { API_BASE_URL, AUTH_TOKEN, printTestConfig } from './test.config';

interface TestResult {
  name: string;
  passed: boolean;
  duration: number;
  error?: string;
  details?: unknown;
}

const MODEL = 'claude-3.7-sonnet';

async function postJson(path: string, body: unknown): Promise<Response> {
  return await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${AUTH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function runCase(name: string, fn: () => Promise<unknown>): Promise<TestResult> {
  const startedAt = Date.now();
  try {
    const details = await fn();
    return { name, passed: true, duration: Date.now() - startedAt, details };
  } catch (error) {
    return {
      name,
      passed: false,
      duration: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertArray(value: unknown, message: string): asserts value is unknown[] {
  assert(Array.isArray(value), message);
}

function assertRecord(value: unknown, message: string): asserts value is Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value), message);
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  const data = JSON.parse(text);
  assertRecord(data, 'response body should be object');
  return data;
}

async function readSseObjects(response: Response): Promise<Record<string, unknown>[]> {
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  const contentType = response.headers.get('content-type') || '';
  assert(
    contentType.includes('text/event-stream'),
    `expected SSE content-type, got ${contentType}`,
  );
  assert(response.body, 'response body should exist');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const objects: Record<string, unknown>[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = drainSseBuffer(buffer, objects);
  }

  if (buffer.trim()) {
    drainSseBlock(buffer, objects);
  }

  return objects;
}

function drainSseBuffer(buffer: string, objects: Record<string, unknown>[]): string {
  let rest = buffer.replace(/\r\n/g, '\n');
  let index = rest.indexOf('\n\n');

  while (index >= 0) {
    const block = rest.slice(0, index);
    rest = rest.slice(index + 2);
    drainSseBlock(block, objects);
    index = rest.indexOf('\n\n');
  }

  return rest;
}

function drainSseBlock(block: string, objects: Record<string, unknown>[]): void {
  const data = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('\n')
    .trim();

  if (!data || data === '[DONE]') return;

  const parsed = JSON.parse(data);
  assertRecord(parsed, 'SSE data should be object');
  objects.push(parsed);
}

async function testOpenAIChat(): Promise<unknown> {
  const data = await readJson(
    await postJson('/v1/chat/completions', {
      model: MODEL,
      messages: [{ role: 'user', content: 'Reply with one short sentence.' }],
      max_tokens: 64,
    }),
  );

  assert(data.object === 'chat.completion', 'OpenAI Chat object mismatch');
  assertArray(data.choices, 'OpenAI Chat choices should be array');
  const choice = data.choices[0];
  assertRecord(choice, 'OpenAI Chat first choice should be object');
  assertRecord(choice.message, 'OpenAI Chat message should be object');
  assert(choice.message.role === 'assistant', 'OpenAI Chat assistant role mismatch');
  return { object: data.object, choices: data.choices.length };
}

async function testOpenAIChatStream(): Promise<unknown> {
  const events = await readSseObjects(
    await postJson('/v1/chat/completions', {
      model: MODEL,
      messages: [{ role: 'user', content: 'Reply with one short sentence.' }],
      max_tokens: 64,
      stream: true,
    }),
  );

  assert(events.some((event) => event.object === 'chat.completion.chunk'), 'missing Chat chunk');
  assert(
    events.some((event) => {
      const choices = event.choices;
      if (!Array.isArray(choices)) return false;
      const choice = choices[0];
      return !!choice && typeof choice === 'object' && 'delta' in choice;
    }),
    'missing Chat delta',
  );
  return { events: events.length };
}

async function testOpenAIResponses(): Promise<unknown> {
  const data = await readJson(
    await postJson('/v1/responses', {
      model: MODEL,
      input: 'Reply with one short sentence.',
      max_output_tokens: 64,
    }),
  );

  assert(data.object === 'response', 'OpenAI Responses object mismatch');
  assert(data.status === 'completed', 'OpenAI Responses status mismatch');
  assert(typeof data.output_text === 'string', 'OpenAI Responses output_text should be string');
  assertArray(data.output, 'OpenAI Responses output should be array');
  return { object: data.object, outputItems: data.output.length };
}

async function testOpenAIResponsesStream(): Promise<unknown> {
  const events = await readSseObjects(
    await postJson('/v1/responses', {
      model: MODEL,
      input: 'Reply with one short sentence.',
      max_output_tokens: 64,
      stream: true,
    }),
  );

  assert(events.some((event) => event.type === 'response.created'), 'missing response.created');
  assert(events.some((event) => event.type === 'response.completed'), 'missing response.completed');
  return { events: events.length };
}

async function testGeminiGenerateContent(): Promise<unknown> {
  const data = await readJson(
    await postJson(`/v1beta/models/${MODEL}:generateContent`, {
      contents: [{ role: 'user', parts: [{ text: 'Reply with one short sentence.' }] }],
      generationConfig: { maxOutputTokens: 64 },
    }),
  );

  assertArray(data.candidates, 'Gemini candidates should be array');
  const candidate = data.candidates[0];
  assertRecord(candidate, 'Gemini first candidate should be object');
  assertRecord(candidate.content, 'Gemini content should be object');
  assertArray(candidate.content.parts, 'Gemini parts should be array');
  return { candidates: data.candidates.length };
}

async function testGeminiStreamGenerateContent(): Promise<unknown> {
  const events = await readSseObjects(
    await postJson(`/v1beta/models/${MODEL}:streamGenerateContent`, {
      contents: [{ role: 'user', parts: [{ text: 'Reply with one short sentence.' }] }],
      generationConfig: { maxOutputTokens: 64 },
    }),
  );

  assert(
    events.some((event) => Array.isArray(event.candidates)),
    'missing Gemini candidates event',
  );
  return { events: events.length };
}

async function runAllTests() {
  console.log('协议兼容集成测试');
  printTestConfig();

  const results = [
    await runCase('OpenAI Chat Completions 非流式', testOpenAIChat),
    await runCase('OpenAI Chat Completions 流式', testOpenAIChatStream),
    await runCase('OpenAI Responses 非流式', testOpenAIResponses),
    await runCase('OpenAI Responses 流式', testOpenAIResponsesStream),
    await runCase('Gemini generateContent 非流式', testGeminiGenerateContent),
    await runCase('Gemini streamGenerateContent 流式', testGeminiStreamGenerateContent),
  ];

  const passed = results.filter((result) => result.passed).length;
  const failed = results.length - passed;

  console.log('\n协议兼容测试汇总:');
  for (const result of results) {
    console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.name} (${result.duration}ms)`);
    if (result.error) {
      console.log(`  ${result.error}`);
    }
  }

  console.log(`通过: ${passed}/${results.length}`);
  process.exit(failed > 0 ? 1 : 0);
}

runAllTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
