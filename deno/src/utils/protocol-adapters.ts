import type {
  AnthropicContent,
  AnthropicMessage,
  AnthropicRequest,
  AnthropicResponse,
  AnthropicResponseContent,
  AnthropicTool,
  AnthropicToolChoice,
  AnthropicToolUse,
} from '../types/anthropic.ts';

type OpenAIChatRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool';

export interface OpenAIChatMessage {
  role: OpenAIChatRole;
  content?: unknown;
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function?: {
      name?: string;
      arguments?: string;
    };
  }>;
  tool_call_id?: string;
  name?: string;
}

export interface OpenAIChatRequest {
  model?: string;
  messages?: OpenAIChatMessage[];
  stream?: boolean;
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  tools?: Array<{
    type?: string;
    function?: {
      name?: string;
      description?: string;
      parameters?: Record<string, unknown>;
    };
  }>;
  tool_choice?: unknown;
}

export interface OpenAIResponsesRequest {
  model?: string;
  input?: unknown;
  instructions?: string;
  stream?: boolean;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  tools?: OpenAIChatRequest['tools'];
  tool_choice?: unknown;
}

export interface GeminiGenerateRequest {
  contents?: Array<{
    role?: 'user' | 'model';
    parts?: Array<Record<string, unknown>>;
  }>;
  systemInstruction?: {
    parts?: Array<Record<string, unknown>>;
  };
  generationConfig?: {
    maxOutputTokens?: number;
    temperature?: number;
    topP?: number;
  };
}

interface AnthropicRequestDraft {
  model: string;
  messages: AnthropicMessage[];
  max_tokens?: number | undefined;
  temperature?: number | undefined;
  top_p?: number | undefined;
  stream?: boolean | undefined;
  system?: string | undefined;
  tools?: AnthropicTool[] | undefined;
  tool_choice?: AnthropicToolChoice | undefined;
}

export function openAIChatToAnthropic(body: OpenAIChatRequest): AnthropicRequest {
  if (!body.model) {
    throw new Error('Missing required field: model');
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new Error('Missing required field: messages');
  }

  const systemParts: string[] = [];
  const messages: AnthropicMessage[] = [];

  for (const message of body.messages) {
    if (message.role === 'system' || message.role === 'developer') {
      const text = openAIContentToText(message.content);
      if (text) systemParts.push(text);
      continue;
    }

    if (message.role === 'assistant') {
      const content = assistantMessageToAnthropicContent(message);
      messages.push({ role: 'assistant', content });
      continue;
    }

    if (message.role === 'tool') {
      const text = openAIContentToText(message.content);
      messages.push({
        role: 'user',
        content: `[tool_result] tool_call_id=${message.tool_call_id || ''}${
          text ? `\n${text}` : ''
        }`,
      });
      continue;
    }

    messages.push({
      role: 'user',
      content: openAIContentToText(message.content),
    });
  }

  return compactAnthropicRequest({
    model: body.model,
    messages,
    stream: body.stream === true,
    max_tokens: body.max_tokens ?? body.max_completion_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    tools: openAIToolsToAnthropic(body.tools),
    tool_choice: openAIToolChoiceToAnthropic(body.tool_choice),
  });
}

export function openAIResponsesToAnthropic(body: OpenAIResponsesRequest): AnthropicRequest {
  if (!body.model) {
    throw new Error('Missing required field: model');
  }

  if (body.input === undefined || body.input === null) {
    throw new Error('Missing required field: input');
  }

  const messages = responsesInputToMessages(body.input);
  return compactAnthropicRequest({
    model: body.model,
    messages,
    stream: body.stream === true,
    max_tokens: body.max_output_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    system: body.instructions,
    tools: openAIToolsToAnthropic(body.tools),
    tool_choice: openAIToolChoiceToAnthropic(body.tool_choice),
  });
}

export function geminiToAnthropic(
  body: GeminiGenerateRequest,
  model: string,
  stream: boolean,
): AnthropicRequest {
  if (!Array.isArray(body.contents) || body.contents.length === 0) {
    throw new Error('Missing required field: contents');
  }

  const system = geminiPartsToText(body.systemInstruction?.parts || []);
  const messages = body.contents.map((content): AnthropicMessage => ({
    role: content.role === 'model' ? 'assistant' : 'user',
    content: geminiPartsToText(content.parts || []),
  }));

  return compactAnthropicRequest({
    model,
    messages,
    stream,
    max_tokens: body.generationConfig?.maxOutputTokens,
    temperature: body.generationConfig?.temperature,
    top_p: body.generationConfig?.topP,
    system: system || undefined,
  });
}

export function anthropicToOpenAIChat(
  response: AnthropicResponse,
  model = response.model,
) {
  const text = responseText(response);
  const toolUses = response.content.filter(isToolUse);
  const message: Record<string, unknown> = {
    role: 'assistant',
    content: text || null,
  };

  if (toolUses.length > 0) {
    message.tool_calls = toolUses.map((tool) => ({
      id: tool.id,
      type: 'function',
      function: {
        name: tool.name,
        arguments: JSON.stringify(tool.input || {}),
      },
    }));
  }

  const reasoning = responseThinking(response);
  if (reasoning) {
    message.reasoning_content = reasoning;
  }

  return {
    id: response.id.replace(/^msg_/, 'chatcmpl_'),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: openAIFinishReason(response.stop_reason),
    }],
    usage: openAIUsage(response),
  };
}

export function anthropicToOpenAIResponse(
  response: AnthropicResponse,
  model = response.model,
) {
  const text = responseText(response);
  const reasoning = responseThinking(response);
  const output: Array<Record<string, unknown>> = [];

  if (reasoning) {
    output.push({
      id: `rs_${response.id}`,
      type: 'reasoning',
      summary: [],
      content: [{ type: 'reasoning_text', text: reasoning }],
    });
  }

  output.push({
    id: response.id,
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
  });

  return {
    id: response.id.replace(/^msg_/, 'resp_'),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model,
    output,
    output_text: text,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      total_tokens: response.usage.input_tokens + response.usage.output_tokens,
    },
  };
}

export function anthropicToGemini(response: AnthropicResponse) {
  const text = responseText(response);
  const reasoning = responseThinking(response);
  const candidate: Record<string, unknown> = {
    content: { role: 'model', parts: [{ text }] },
    finishReason: geminiFinishReason(response.stop_reason),
    index: 0,
  };

  if (reasoning) {
    candidate.thought = reasoning;
  }

  return {
    candidates: [candidate],
    usageMetadata: {
      promptTokenCount: response.usage.input_tokens,
      candidatesTokenCount: response.usage.output_tokens,
      totalTokenCount: response.usage.input_tokens + response.usage.output_tokens,
    },
  };
}

export function responseText(response: AnthropicResponse): string {
  return response.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

export function responseThinking(response: AnthropicResponse): string {
  return response.content
    .flatMap((block) => block.type === 'thinking' ? [block.thinking] : [])
    .join('');
}

export function openAIFinishReason(
  stopReason: AnthropicResponse['stop_reason'] | undefined,
): 'stop' | 'length' | 'tool_calls' | null {
  if (stopReason === 'max_tokens') return 'length';
  if (stopReason === 'tool_use') return 'tool_calls';
  if (stopReason === null) return null;
  return 'stop';
}

export function geminiFinishReason(
  stopReason: AnthropicResponse['stop_reason'] | undefined,
): 'STOP' | 'MAX_TOKENS' | 'OTHER' {
  if (stopReason === 'max_tokens') return 'MAX_TOKENS';
  if (stopReason === 'end_turn' || stopReason === 'stop_sequence' || stopReason === undefined) {
    return 'STOP';
  }
  return 'OTHER';
}

function compactAnthropicRequest(request: AnthropicRequestDraft): AnthropicRequest {
  const compacted: AnthropicRequest = {
    model: request.model,
    messages: request.messages,
  };

  if (request.max_tokens !== undefined) compacted.max_tokens = request.max_tokens;
  if (request.temperature !== undefined) compacted.temperature = request.temperature;
  if (request.top_p !== undefined) compacted.top_p = request.top_p;
  if (request.stream !== undefined) compacted.stream = request.stream;
  if (request.system !== undefined && request.system !== '') compacted.system = request.system;
  if (request.tools !== undefined && request.tools.length > 0) compacted.tools = request.tools;
  if (request.tool_choice !== undefined) compacted.tool_choice = request.tool_choice;
  return compacted;
}

function openAIContentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return '';

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (!part || typeof part !== 'object') return '';
        const block = part as Record<string, unknown>;
        if (typeof block.text === 'string') return block.text;
        if (typeof block.input_text === 'string') return block.input_text;
        if (typeof block.output_text === 'string') return block.output_text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  if (typeof content === 'object') {
    const block = content as Record<string, unknown>;
    if (typeof block.text === 'string') return block.text;
  }

  return String(content);
}

function assistantMessageToAnthropicContent(
  message: OpenAIChatMessage,
): string | AnthropicContent[] {
  const contentBlocks: AnthropicContent[] = [];
  const text = openAIContentToText(message.content);
  if (text) {
    contentBlocks.push({ type: 'text', text });
  }

  for (const toolCall of message.tool_calls || []) {
    const name = toolCall.function?.name;
    if (!name) continue;
    contentBlocks.push({
      type: 'tool_use',
      id: toolCall.id || `call_${crypto.randomUUID()}`,
      name,
      input: parseJsonObject(toolCall.function?.arguments || '{}'),
    });
  }

  if (contentBlocks.length === 0) return '';
  if (contentBlocks.length === 1 && contentBlocks[0]?.type === 'text') {
    return contentBlocks[0].text;
  }
  return contentBlocks;
}

function responsesInputToMessages(input: unknown): AnthropicMessage[] {
  if (typeof input === 'string') {
    return [{ role: 'user', content: input }];
  }

  if (!Array.isArray(input) || input.length === 0) {
    throw new Error('Invalid input format');
  }

  return input.map((item): AnthropicMessage => {
    if (typeof item === 'string') {
      return { role: 'user', content: item };
    }

    if (!item || typeof item !== 'object') {
      return { role: 'user', content: String(item) };
    }

    const message = item as { role?: string; content?: unknown };
    return {
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: openAIContentToText(message.content),
    };
  });
}

function openAIToolsToAnthropic(tools: OpenAIChatRequest['tools']): AnthropicTool[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;

  const mapped = tools.flatMap((tool): AnthropicTool[] => {
    if (tool.type && tool.type !== 'function') return [];
    const fn = tool.function;
    if (!fn?.name) return [];
    const mappedTool: AnthropicTool = {
      name: fn.name,
      input_schema: normalizeSchema(fn.parameters),
    };
    if (fn.description !== undefined) mappedTool.description = fn.description;
    return [mappedTool];
  });

  return mapped.length > 0 ? mapped : undefined;
}

function openAIToolChoiceToAnthropic(toolChoice: unknown): AnthropicToolChoice | undefined {
  if (!toolChoice || toolChoice === 'none') return undefined;
  if (toolChoice === 'auto') return { type: 'auto' };
  if (toolChoice === 'required') return { type: 'any' };

  if (typeof toolChoice === 'object') {
    const choice = toolChoice as {
      type?: string;
      function?: { name?: string };
    };
    if (choice.type === 'function' && choice.function?.name) {
      return { type: 'tool', name: choice.function.name };
    }
  }

  return undefined;
}

function normalizeSchema(
  schema: Record<string, unknown> | undefined,
): AnthropicTool['input_schema'] {
  if (!schema) {
    return { type: 'object', properties: {} };
  }

  return {
    type: 'object',
    properties: isRecord(schema.properties) ? schema.properties : {},
    ...(Array.isArray(schema.required) ? { required: schema.required as string[] } : {}),
  };
}

function geminiPartsToText(parts: Array<Record<string, unknown>>): string {
  return parts
    .map((part) => typeof part.text === 'string' ? part.text : '')
    .filter(Boolean)
    .join('\n');
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isToolUse(block: AnthropicResponseContent): block is AnthropicToolUse {
  return block.type === 'tool_use';
}

function openAIUsage(response: AnthropicResponse) {
  return {
    prompt_tokens: response.usage.input_tokens,
    completion_tokens: response.usage.output_tokens,
    total_tokens: response.usage.input_tokens + response.usage.output_tokens,
  };
}
