import type { AnthropicResponseContent } from '../types/anthropic';

/** 服务端工具记录转成客户端可读文本，保留结果、来源和错误，不触发客户端执行。 */
export function toClientContent(block: AnthropicResponseContent): AnthropicResponseContent {
  if (block.type === 'server_tool_use') {
    return { type: 'text', text: `上游工具调用记录：${JSON.stringify(block)}` };
  }
  if (
    [
      'tool_result',
      'web_search_tool_result',
      'web_fetch_tool_result',
      'code_execution_tool_result',
      'bash_code_execution_tool_result',
      'text_editor_code_execution_tool_result',
    ].includes(block.type)
  ) {
    return { type: 'text', text: `上游工具结果：${JSON.stringify(block)}` };
  }
  return block;
}
