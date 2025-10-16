# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

**Sider2Claude** 是一个 API 代理服务，将 Sider AI API 转换为完全兼容 Anthropic API 格式的服务，专门为 Claude Code CLI 提供支持。

**核心技术栈**：
- **运行时**: Bun v1.0+（高性能 JavaScript 运行时）
- **Web 框架**: Hono（轻量级、高性能）
- **语言**: TypeScript（完全类型安全）
- **构建工具**: tsup

## 开发命令

```bash
# 开发
bun run dev                    # 开发模式（热重载，监听端口 4141）
bun run build                  # 构建生产版本到 dist/
bun run start                  # 启动生产版本
bun run lint                   # ESLint 代码检查
bun run typecheck              # TypeScript 类型检查

# 依赖管理
bun install                    # 安装依赖（推荐使用 Bun）
npm install                    # 或使用 npm

# 快速测试
curl http://localhost:4141/health                    # 健康检查
curl -X POST http://localhost:4141/v1/messages \
  -H "Authorization: Bearer dummy" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-3.7-sonnet","messages":[{"role":"user","content":"Hello"}],"max_tokens":1024}'
```

## 核心架构

### 1. 会话保持机制（最重要）

项目实现了两层会话管理，确保多轮对话的上下文连续性：

**优先方案 - 真实会话**：
- 使用 `convertAnthropicToSiderAsync()` 从 Sider 获取完整会话历史
- 会话 ID 通过 `cid` query 参数或 `X-Conversation-ID` header 传递
- 在 SSE `message_start` 事件中捕获真实的 `cid` 和 `parent_message_id`
- 存储在 `siderSessionStore`（内存）

**降级方案 - 本地会话**：
- 当获取真实历史失败时，使用 `convertAnthropicToSiderSync()`
- 基于消息内容指纹识别会话
- 存储在 `conversationStore`（内存）

**关键文件**：
- [src/utils/sider-session-manager.ts](src/utils/sider-session-manager.ts) - 真实会话管理
- [src/utils/conversation-manager.ts](src/utils/conversation-manager.ts) - 本地会话管理
- [src/utils/request-converter.ts](src/utils/request-converter.ts) - 转换逻辑

### 2. API 流转流程

```
客户端请求 (Anthropic 格式)
    ↓
中间件认证 (Bearer Token)
    ↓
请求转换 (Anthropic → Sider 格式)
    ├─ convertAnthropicToSiderAsync() [优先：多轮对话]
    └─ convertAnthropicToSiderSync() [降级：新会话]
    ↓
Sider API 调用 (SSE 流式)
    ↓
SSE 事件解析
    ├─ message_start → 捕获会话 ID
    ├─ reasoning_content → 推理内容（think 模型）
    ├─ text → 最终文本内容
    └─ tool_call_* → 工具调用事件
    ↓
响应转换 (Sider → Anthropic 格式)
    ↓
客户端响应 + 会话信息响应头
```

### 3. 模块职责

**核心路由** ([src/routes/messages.ts](src/routes/messages.ts)):
- `POST /v1/messages` - 主 API 端点（Anthropic 兼容）
- `POST /v1/messages/count_tokens` - Token 计数
- `GET/POST /v1/messages/conversations` - 本地会话管理
- `GET/POST /v1/messages/sider-sessions` - Sider 会话管理

**类型定义**:
- [src/types/anthropic.ts](src/types/anthropic.ts) - Anthropic API 完整类型
- [src/types/sider.ts](src/types/sider.ts) - Sider API 类型

**工具函数**:
- [src/utils/request-converter.ts](src/utils/request-converter.ts) - 请求格式转换
- [src/utils/response-converter.ts](src/utils/response-converter.ts) - 响应格式转换
- [src/utils/sider-client.ts](src/utils/sider-client.ts) - Sider HTTP 客户端
- [src/utils/sider-conversation.ts](src/utils/sider-conversation.ts) - 会话历史获取

**中间件**:
- [src/middleware/auth.ts](src/middleware/auth.ts) - Bearer Token 认证（支持 "dummy" Token）

### 4. 模型映射

```typescript
// Anthropic 模型 → Sider 模型
'claude-3.7-sonnet' → 'claude-3.7-sonnet-think'
'claude-4-sonnet'   → 'claude-4-sonnet-think'
'claude-3-sonnet'   → 'claude-3.7-sonnet-think'
```

在 [src/utils/request-converter.ts:mapModelName()](src/utils/request-converter.ts) 中维护此映射。

## 开发约束和规范

### 必须遵守（来自 shrimp-rules.md）

**架构约束**：
- ✅ 必须使用 Hono 框架和 Bun 运行时
- ✅ 保持 `/v1/messages` 端点签名不变
- ✅ 保持 Anthropic API 完全兼容

**会话保持规范**：
- ✅ 优先使用 `convertAnthropicToSiderAsync()` 获取真实会话历史
- ✅ 失败时自动降级到 `convertAnthropicToSiderSync()`
- ✅ 在 `message_start` 事件中捕获真实的 `cid` 和 `parent_message_id`
- ✅ 响应中包含会话信息 headers（X-Conversation-ID、X-Assistant-Message-ID、X-User-Message-ID）

**AI 决策优先级**：
1. 保持 Anthropic API 兼容性（绝不破坏 Claude Code 集成）
2. 维护会话保持功能（确保多轮对话正常）
3. 实现工具调用功能（支持 Claude Code 的工具使用）
4. 保持 copilot-api 架构一致性
5. 维护 Sider API 调用稳定性

### 严禁事项

- ❌ 破坏 Anthropic API 兼容性
- ❌ 删除会话管理相关文件
- ❌ 硬编码会话 ID
- ❌ 忽略工具调用的错误处理
- ❌ 修改现有 `/v1/messages` 端点签名

## 环境配置

创建 `.env` 文件：

```bash
# 服务器配置
PORT=4141
NODE_ENV=development

# Sider AI API 配置
SIDER_API_URL=https://sider.ai/api/chat/v1/completions
SIDER_AUTH_TOKEN=<你的 Sider JWT Token>

# 可选配置
LOG_LEVEL=debug
REQUEST_TIMEOUT=30000
```

**Claude Code 集成**（见 [CLAUDE_CODE_SETUP.md](CLAUDE_CODE_SETUP.md)）：

```bash
export ANTHROPIC_BASE_URL=http://localhost:4141
export ANTHROPIC_AUTH_TOKEN=dummy
export ANTHROPIC_MODEL=claude-3.7-sonnet
```

## 关键实现细节

### SSE 流式响应解析

Sider API 返回 SSE 格式流，事件类型：
- `credit_info` - 配额信息
- `message_start` - **重要**：包含 `cid`、`user_message_id`、`assistant_message_id`
- `reasoning_content` - 推理内容（think 模型）
- `text` - 最终文本内容
- `tool_call_start`/`tool_call_progress`/`tool_call_result` - 工具调用事件

解析逻辑在 [src/utils/sider-client.ts:parseSSEResponse()](src/utils/sider-client.ts) 中实现。

### 会话 ID 获取流程

1. 客户端请求时可选提供 `cid`（query 参数或 header）
2. 如果提供了 `cid`，尝试从 `siderSessionStore` 获取会话信息
3. 如果找到，使用 `getNextParentMessageId()` 获取正确的 `parent_message_id`
4. 在 SSE `message_start` 事件中，捕获 Sider 返回的真实 `cid`
5. 调用 `saveSiderSession()` 保存新的会话信息到内存
6. 在响应 headers 中返回会话信息给客户端

### 工具调用功能（部分实现）

- `buildSafeToolsConfig()` 已启用工具转换
- 支持 Anthropic 标准的 `tools` 和 `tool_choice` 参数
- 完整的工具调用处理链路需要参考 copilot-api 实现
- 工具调用结果的标准化处理需要增强

## 当前状态

**已实现**：
- ✅ API 格式转换
- ✅ 会话保持（两层机制）
- ✅ SSE 流式响应解析
- ✅ 认证中间件
- ✅ 错误处理
- ✅ Token 计数端点

**部分实现**：
- ⚠️ 工具调用功能（基础支持已启用，完整链路待增强）
- ⚠️ 流式响应（当前为模拟实现，按词分割发送）

**待实现**：
- ⏳ CLI 功能（citty 框架已导入但未使用）
- ⏳ 精确 Token 计算（使用 gpt-tokenizer）
- ⏳ 真正的 SSE 流式响应（参考 copilot-api）

## 调试技巧

1. **查看会话状态**：
   ```bash
   curl http://localhost:4141/v1/messages/sider-sessions
   curl http://localhost:4141/v1/messages/conversations
   ```

2. **启用详细日志**：设置 `LOG_LEVEL=debug` 在 `.env` 中

3. **检查会话 ID 传递**：在响应 headers 中查看 `X-Conversation-ID`

4. **测试多轮对话**：
   ```bash
   # 第一轮（获取 cid）
   curl -X POST http://localhost:4141/v1/messages \
     -H "Authorization: Bearer dummy" \
     -H "Content-Type: application/json" \
     -d '{"model":"claude-3.7-sonnet","messages":[{"role":"user","content":"Hello"}],"max_tokens":1024}' \
     -v 2>&1 | grep -i "X-Conversation-ID"

   # 第二轮（使用 cid）
   curl -X POST "http://localhost:4141/v1/messages?cid=<获取的cid>" \
     -H "Authorization: Bearer dummy" \
     -H "Content-Type: application/json" \
     -d '{"model":"claude-3.7-sonnet","messages":[{"role":"user","content":"Continue"}],"max_tokens":1024}'
   ```

## 参考文档

- [README.md](README.md) - 项目介绍和快速开始
- [CLAUDE_CODE_SETUP.md](CLAUDE_CODE_SETUP.md) - Claude Code CLI 集成指南
- [shrimp-rules.md](shrimp-rules.md) - AI 代理开发规范和约束
