import type { AnthropicContent, AnthropicRequest } from '../types/anthropic.ts';

interface FormatOptions {
  includeHistory: boolean;
  currentUserInput: string;
}

export function buildSiderMessageText(
  request: AnthropicRequest,
  options: FormatOptions,
): string {
  if (!options.includeHistory) {
    return buildSingleTurnText(request, options.currentUserInput);
  }

  return buildTranscriptText(request);
}

function buildSingleTurnText(
  request: AnthropicRequest,
  currentUserInput: string,
): string {
  if (request.system && request.messages.length === 1) {
    return `${request.system}\n\n${currentUserInput}`;
  }

  return currentUserInput;
}

function buildTranscriptText(request: AnthropicRequest): string {
  const parts: string[] = [];

  if (request.system) {
    parts.push(`System: ${request.system}`);
  }

  for (const message of request.messages) {
    const text = contentToText(message.content).trim();
    if (!text) {
      continue;
    }

    const role = message.role === 'assistant' ? 'Assistant' : 'User';
    parts.push(`${role}: ${text}`);
  }

  parts.push('Assistant:');
  return parts.join('\n\n');
}

function contentToText(content: string | AnthropicContent[]): string {
  if (typeof content === 'string') {
    return content;
  }

  return content
    .flatMap((block) => contentBlockToText(block))
    .join('\n')
    .trim();
}

function contentBlockToText(block: AnthropicContent): string[] {
  if (block.type === 'text') {
    return block.text ? [block.text] : [];
  }

  if (block.type === 'tool_use') {
    return [
      `[tool_use:${block.name || 'unknown'}] id=${block.id || ''} input=${
        JSON.stringify(block.input ?? {})
      }`,
    ];
  }

  if (block.type === 'tool_result') {
    const content = typeof block.content === 'string'
      ? block.content
      : Array.isArray(block.content)
      ? contentToText(block.content)
      : '';
    return [
      `[tool_result] tool_use_id=${block.tool_use_id || ''}${
        block.is_error ? ' is_error=true' : ''
      }${content ? `\n${content}` : ''}`,
    ];
  }

  return [];
}
