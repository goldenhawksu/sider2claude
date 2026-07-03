import type { AnthropicResponse } from '../src/types/anthropic.ts';
import {
  anthropicToGemini,
  anthropicToOpenAIChat,
  anthropicToOpenAIResponse,
  geminiToAnthropic,
  openAIChatToAnthropic,
  openAIResponsesToAnthropic,
} from '../src/utils/protocol-adapters.ts';

function assertEquals<T>(actual: T, expected: T) {
  if (actual !== expected) {
    throw new Error(`assert failed: expected ${String(expected)}, actual ${String(actual)}`);
  }
}

function assertArray(value: unknown): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new Error('assert failed: expected array');
  }
}

function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('assert failed: expected object');
  }
}

Deno.test('OpenAI Chat 请求会转换为 Anthropic Messages 请求', () => {
  const request = openAIChatToAnthropic({
    model: 'gpt-compatible',
    messages: [
      { role: 'system', content: 'system rule' },
      { role: 'developer', content: 'developer rule' },
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      {
        role: 'assistant',
        content: 'previous answer',
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'lookup', arguments: '{"query":"deno"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'tool result' },
    ],
    max_completion_tokens: 256,
    temperature: 0.2,
    stream: true,
    tools: [{
      type: 'function',
      function: {
        name: 'lookup',
        description: 'lookup docs',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
    }],
    tool_choice: { type: 'function', function: { name: 'lookup' } },
  });

  assertEquals(request.model, 'gpt-compatible');
  assertEquals(request.system, 'system rule\n\ndeveloper rule');
  assertEquals(request.messages.length, 3);
  assertEquals(request.messages[0]?.role, 'user');
  assertEquals(request.messages[0]?.content, 'hello');

  const assistantContent = request.messages[1]?.content;
  assertArray(assistantContent);
  assertEquals((assistantContent[0] as { text?: string }).text, 'previous answer');
  assertEquals((assistantContent[1] as { name?: string }).name, 'lookup');

  assertEquals(request.messages[2]?.role, 'user');
  assertEquals(
    request.messages[2]?.content,
    '[tool_result] tool_call_id=call_1\ntool result',
  );
  assertEquals(request.max_tokens, 256);
  assertEquals(request.stream, true);
  assertEquals(request.tools?.[0]?.name, 'lookup');
  assertEquals(request.tool_choice?.type, 'tool');
});

Deno.test('OpenAI Responses 请求会转换为 Anthropic Messages 请求', () => {
  const request = openAIResponsesToAnthropic({
    model: 'gpt-responses-compatible',
    instructions: 'be concise',
    input: [
      { role: 'user', content: [{ type: 'input_text', text: 'write one line' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
    ],
    max_output_tokens: 128,
    top_p: 0.9,
  });

  assertEquals(request.model, 'gpt-responses-compatible');
  assertEquals(request.system, 'be concise');
  assertEquals(request.messages.length, 2);
  assertEquals(request.messages[0]?.role, 'user');
  assertEquals(request.messages[0]?.content, 'write one line');
  assertEquals(request.messages[1]?.role, 'assistant');
  assertEquals(request.messages[1]?.content, 'done');
  assertEquals(request.max_tokens, 128);
  assertEquals(request.top_p, 0.9);
});

Deno.test('Gemini 原生请求会转换为 Anthropic Messages 请求', () => {
  const request = geminiToAnthropic(
    {
      systemInstruction: { parts: [{ text: 'gemini system' }] },
      contents: [
        { role: 'user', parts: [{ text: 'hello' }] },
        { role: 'model', parts: [{ text: 'hi' }] },
        { role: 'user', parts: [{ text: 'continue' }] },
      ],
      generationConfig: {
        maxOutputTokens: 64,
        temperature: 0.3,
        topP: 0.8,
      },
    },
    'gemini-compatible',
    true,
  );

  assertEquals(request.model, 'gemini-compatible');
  assertEquals(request.system, 'gemini system');
  assertEquals(request.messages.length, 3);
  assertEquals(request.messages[0]?.role, 'user');
  assertEquals(request.messages[1]?.role, 'assistant');
  assertEquals(request.messages[2]?.content, 'continue');
  assertEquals(request.max_tokens, 64);
  assertEquals(request.stream, true);
});

Deno.test('Anthropic 响应会映射为 OpenAI Chat、Responses 与 Gemini 响应', () => {
  const anthropic: AnthropicResponse = {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-compatible',
    content: [
      { type: 'thinking', thinking: 'internal summary' },
      { type: 'text', text: 'visible answer' },
      { type: 'tool_use', id: 'tool_1', name: 'lookup', input: { query: 'deno' } },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 10, output_tokens: 5 },
  };

  const chat = anthropicToOpenAIChat(anthropic, 'openai-facing');
  assertEquals(chat.object, 'chat.completion');
  assertEquals(chat.model, 'openai-facing');
  assertEquals(chat.choices[0]?.finish_reason, 'tool_calls');
  assertEquals(chat.choices[0]?.message.content, 'visible answer');
  assertEquals(chat.choices[0]?.message.reasoning_content, 'internal summary');
  assertEquals(chat.usage.total_tokens, 15);

  const toolCalls = chat.choices[0]?.message.tool_calls;
  assertArray(toolCalls);
  assertEquals((toolCalls[0] as { id?: string }).id, 'tool_1');

  const response = anthropicToOpenAIResponse(anthropic, 'responses-facing');
  assertEquals(response.object, 'response');
  assertEquals(response.model, 'responses-facing');
  assertEquals(response.output_text, 'visible answer');
  assertEquals(response.usage.total_tokens, 15);
  assertEquals(response.output.length, 2);

  const gemini = anthropicToGemini(anthropic);
  const candidate = gemini.candidates[0];
  assertRecord(candidate);
  assertEquals(candidate.finishReason, 'OTHER');
  assertEquals(candidate.thought, 'internal summary');
  assertEquals(gemini.usageMetadata.totalTokenCount, 15);
});
