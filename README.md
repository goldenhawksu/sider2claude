# Sider2Claude

Sider2Claude 是一个面向 Claude Code 的 Anthropic API 兼容代理。当前落地方案是：

- 主模型普通对话由 Sider 提供，模型仍以 Claude/Anthropic 名称对外暴露。
- Claude Code 工具、MCP 工具、自定义 `tool_use` 等 Sider 无法稳定提供的能力，由 DeepSeek Anthropic
  兼容端补齐。
- DeepSeek 上游模型固定默认为 `deepseek-v4-flash`，对外响应仍保留客户端请求的 Claude 模型名。
- DeepSeek 返回的 `thinking` / `redacted_thinking` / `tool_use` 内容块会按 Anthropic Messages
  结构透传。
- 转发到 DeepSeek 前会删除顶层 `thinking` 参数，并把历史 `thinking` / `redacted_thinking` /
  `tool_use` / `tool_result` 内容块转录为普通文本，避免 DeepSeek 在工具续轮中要求完整 thinking
  passback 而返回 400。
