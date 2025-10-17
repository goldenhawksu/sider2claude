# Sider2Claude 限制与已知问题

## MCP Server / Agent 调用限制

### 问题描述

当使用 Sider2Claude 代理服务(特别是 Deno Deploy 部署)时,**Claude Code 的 MCP server 和 invoke-agent 功能无法正常工作**。

### 技术原因

1. **`<invoke-agent>` 不是标准 Anthropic API 格式**
   - 这是 Claude Code 内部使用的特殊语法
   - Sider AI 将其作为普通文本返回,而非工具调用
   - Claude Code 无法识别返回的文本作为 agent 调用指令

2. **MCP Server 工具调用链路缺失**
   - Sider2Claude 当前只支持基础的 Anthropic API 工具调用
   - 完整的 MCP server 工具调用需要复杂的双向通信机制
   - 需要实现工具调用结果的往返传递和状态管理

### 具体表现

当 Claude 尝试调用 agent 时,你会在响应中看到类似以下的**纯文本输出**:

```xml
<invoke-agent mcp-server-name="agents" agent-name="sequential-thinking" max-output-tokens="20000">
<task>
分析 stock_screener_tool 项目...
</task>
</invoke-agent>
```

**这不是实际的工具调用**,只是 Claude 输出的建议文本。

### 受影响的功能

以下 Claude Code 功能在使用 Sider2Claude 时**不可用**:

- ❌ MCP Server 工具调用
- ❌ `<invoke-agent>` 子代理调用
- ❌ 需要交互式工具结果的复杂工作流
- ❌ 自定义 MCP server 集成

### 仍然可用的功能

以下功能**正常工作**:

- ✅ 基础对话和多轮对话
- ✅ 代码分析和建议
- ✅ 文件读写操作(通过 Claude Code 内置工具)
- ✅ Bash 命令执行(通过 Claude Code 内置工具)
- ✅ 会话保持和上下文管理
- ✅ Sider AI 原生支持的工具(search, web_browse, create_image)

## 解决方案

### 方案 1: 使用官方 Anthropic API(推荐)

如果你需要完整的 MCP server 支持:

```bash
# 使用官方 Anthropic API
export ANTHROPIC_API_KEY=<your-actual-anthropic-key>
unset ANTHROPIC_BASE_URL  # 移除代理配置

# 启动 Claude Code
claude code
```

**优点**:
- ✅ 所有功能完全支持
- ✅ 最佳稳定性和性能
- ✅ 官方支持和更新

**缺点**:
- ❌ 需要付费 Anthropic API key
- ❌ 有 API 调用限制和费用

### 方案 2: 混合使用(平衡方案)

根据任务类型切换配置:

**简单任务使用 Sider2Claude**(免费):
```bash
export ANTHROPIC_BASE_URL=https://deno-sider2claude.deno.dev
export ANTHROPIC_AUTH_TOKEN=sk-this-is-free-sider2claude-key
export ANTHROPIC_MODEL=claude-4.5-sonnet
```

**复杂任务使用官方 API**(付费但功能完整):
```bash
export ANTHROPIC_API_KEY=<your-key>
unset ANTHROPIC_BASE_URL
```

### 方案 3: 明确任务范围(当前可行)

在使用 Sider2Claude 时,向 Claude Code 明确说明**不要使用 agent**:

```bash
claude code "请直接完成这个任务,不要调用子代理或 MCP server"
```

或者在全局 `~/.claude/CLAUDE.md` 中添加:

```markdown
# 当使用代理 API 时的约束

当检测到 ANTHROPIC_BASE_URL 不是官方 API 时:
- 不要尝试调用 invoke-agent
- 不要尝试使用 MCP server 工具
- 直接完成任务,不依赖子代理
```

## 未来改进计划

我们计划在未来版本中改进 MCP server 支持:

### 短期目标(v1.1)
- [ ] 在响应转换器中检测 `<invoke-agent>` 标签
- [ ] 转换为 Anthropic 标准的 `tool_use` 格式
- [ ] 实现基础的工具调用往返机制

### 中期目标(v1.2)
- [ ] 完整实现 MCP server 工具调用链路
- [ ] 支持自定义 MCP server 配置
- [ ] 工具调用结果缓存和优化

### 长期目标(v2.0)
- [ ] 完全兼容 Claude Code 的所有 MCP 功能
- [ ] 支持复杂的多步骤工具调用工作流
- [ ] 实现工具调用的流式响应

## 相关资源

- [Anthropic API 文档](https://docs.anthropic.com/en/api/messages)
- [Claude Code MCP Server 文档](https://docs.anthropic.com/en/docs/claude-code/mcp-servers)
- [Sider2Claude README](../README.md)
- [Sider2Claude 架构说明](../CLAUDE.md)

## 贡献

如果你对实现 MCP server 支持感兴趣,欢迎提交 PR!

关键文件:
- `deno/src/utils/response-converter.ts` - 响应格式转换
- `deno/src/utils/request-converter.ts` - 请求格式转换
- `deno/src/routes/messages.ts` - 主 API 端点

---

**最后更新**: 2025-10-17
**状态**: 已知限制,计划改进
