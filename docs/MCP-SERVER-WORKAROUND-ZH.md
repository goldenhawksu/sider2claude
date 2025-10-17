# MCP Server 无法使用的解决方案(中文简版)

## 问题现象

使用Deno Deploy的Sider2Claude时,Claude Code会输出类似这样的**纯文本**:

```xml
<invoke-agent mcp-server-name="agents" agent-name="sequential-thinking">
<task>分析项目...</task>
</invoke-agent>
```

**这不是真正的agent调用**,只是文本输出。

## 原因

`<invoke-agent>` 是Claude Code特有的内部语法,不是标准Anthropic API。当使用代理服务时:
- Sider AI把它当作普通文本返回
- Claude Code无法识别这个文本为agent调用指令

## 三种解决方案

### 方案1: 使用官方API(最佳)

```bash
# 切换到官方API(需要付费key)
export ANTHROPIC_API_KEY=<你的真实key>
unset ANTHROPIC_BASE_URL

# 启动Claude Code
claude code
```

**优点**: 所有功能完全支持
**缺点**: 需要付费

### 方案2: 混合使用(推荐)

根据任务复杂度切换:

**简单任务(免费)**:
```bash
export ANTHROPIC_BASE_URL=https://deno-sider2claude.deno.dev
export ANTHROPIC_AUTH_TOKEN=sk-this-is-free-sider-key
```

**复杂任务(付费但功能全)**:
```bash
export ANTHROPIC_API_KEY=<你的key>
unset ANTHROPIC_BASE_URL
```

### 方案3: 明确告诉Claude不要用agent(当前可行)

**命令行明确指示**:
```bash
claude code "请直接完成这个任务,不要调用子代理"
```

**或在 `~/.claude/CLAUDE.md` 添加全局规则**:
```markdown
# 代理API使用约束

当 ANTHROPIC_BASE_URL 不是官方API时:
- ❌ 不要尝试调用 invoke-agent
- ❌ 不要使用 MCP server 工具
- ✅ 直接完成任务,不依赖子代理
```

## 哪些功能可用/不可用

### ✅ 可用功能

- 基础对话和多轮对话
- 代码分析和建议
- 文件读写(Claude Code内置工具)
- Bash命令执行(Claude Code内置工具)
- 会话保持

### ❌ 不可用功能

- MCP Server工具调用
- `<invoke-agent>` 子代理调用
- 复杂工具交互工作流
- 自定义MCP server集成

## 未来改进计划

我们计划在未来版本中支持MCP server:

- **v1.1**: 检测并转换 `<invoke-agent>` 为标准工具调用
- **v1.2**: 完整实现MCP server工具调用链路
- **v2.0**: 完全兼容Claude Code的所有MCP功能

## 更多信息

详细文档(英文): [docs/LIMITATIONS.md](LIMITATIONS.md)

---

**最后更新**: 2025-10-17
