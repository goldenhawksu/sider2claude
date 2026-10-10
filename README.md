# Sider2Claude

Sider2Claude 是一个面向 Claude Code 的 Anthropic API 兼容代理。当前落地方案是：

- 主模型普通对话由 Sider 提供，模型仍以 Claude/Anthropic 名称对外暴露。
- 非流式 Controller 可用 Sider 5.5 文本工具契约；流式 Claude Code 工具请求在 SSE 开始前由
  混合路由交给 Anthropic 兼容能力端，避免不可回退的半截响应。
- DeepSeek 上游模型固定默认为 `deepseek-v4-flash`，对外响应仍保留客户端请求的 Claude 模型名。
- DeepSeek 返回的 `thinking` / `redacted_thinking` / `tool_use` 内容块会按 Anthropic Messages
  结构透传。
- 转发到 DeepSeek 前会删除顶层 `thinking` 参数，并把历史 `thinking` / `redacted_thinking` /
  `tool_use` / `tool_result` 内容块转录为普通文本，避免 DeepSeek 在工具续轮中要求完整 thinking
  passback 而返回 400。
