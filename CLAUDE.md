# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

**Sider2Claude** 是一个智能 API 代理服务，支持：
1. 将 Sider AI API 转换为 Anthropic API 格式
2. 智能路由到 Sider AI 或原生 Anthropic API
3. 完全兼容 Claude Code CLI 和其他 Anthropic 客户端

**核心技术栈**：
- **运行时**: Bun v1.0+ / Deno（双运行时支持）
- **Web 框架**: Hono（轻量级、高性能）
- **语言**: TypeScript（完全类型安全）
- **构建工具**: tsup（Bun 版本）

## 开发命令

```bash
# Bun 运行时
bun run dev                    # 开发模式 (热重载, 端口 4141)
bun run build                  # 构建生产版本到 dist/
bun run start                  # 启动生产版本
bun run lint                   # ESLint 代码检查
bun run typecheck              # TypeScript 类型检查

# Deno 运行时
cd deno
deno task dev                  # 开发模式 (端口 4142)
deno task start                # 生产模式

# 测试
cd test
bun run quick-test.ts          # 快速测试
bun run 01-health.test.ts      # 健康检查测试
bun run 02-basic-messages.test.ts  # 基础消息测试
bun run 03-session.test.ts     # 会话保持测试
bun run 04-streaming.test.ts   # 流式响应测试
bun run 05-token-count.test.ts # Token 计数测试

# 完整测试套件
./run-tests.sh all             # Linux/macOS
run-tests.bat all              # Windows
```

## 核心架构

### 1. 混合路由系统 ⭐ 新增

项目实现了智能路由引擎，可以根据请求自动选择最优后端：

**路由决策流程**：
```
客户端请求 (Anthropic 格式)
    ↓
路由引擎分析 (RouterEngine)
    ├─ 检查模型支持
    ├─ 检查工具调用需求
    ├─ 检查会话绑定
    └─ 应用路由策略
    ↓
    ├─→ Anthropic API (官方 API)
    └─→ Sider AI (转换后调用)
```

**关键文件**：
- [src/routing/router-engine.ts](src/routing/router-engine.ts) - 路由决策引擎
- [src/config/backends.ts](src/config/backends.ts) - 后端配置管理
- [src/routes/messages-hybrid.ts](src/routes/messages-hybrid.ts) - 混合路由主入口
- [src/adapters/anthropic-adapter.ts](src/adapters/anthropic-adapter.ts) - Anthropic API 适配器

**配置文件** (`.backend.config.json`):
```json
{
  "sider": {
    "enabled": true,
    "priority": 1,
    "supportedModels": ["claude-3.7-sonnet", "claude-4-sonnet", ...]
  },
  "anthropic": {
    "enabled": false,  // 需要 ANTHROPIC_API_KEY 环境变量
    "priority": 2,
    "apiKey": "${ANTHROPIC_API_KEY}"
  },
  "routing": {
    "strategy": "priority",  // priority | round-robin | model-based
    "sessionSticky": true
  }
}
```

### 2. 双层认证机制

项目实现了双层认证，确保安全性和灵活性：

**架构流程**：
```
客户端 (Bearer Token: AUTH_TOKEN)
    ↓ 验证
中间件 (requireAuth)
    ↓ 通过
路由引擎决策
    ├─→ Anthropic API (使用 ANTHROPIC_API_KEY)
    └─→ Sider AI (使用 SIDER_AUTH_TOKEN)
```

**环境变量**：
- `AUTH_TOKEN`: 客户端认证 Token（自定义，供 Claude Code 使用）
- `SIDER_AUTH_TOKEN`: Sider AI 的 JWT Token（从 sider.ai 获取，以 `eyJhbGci` 开头）
- `ANTHROPIC_API_KEY`: Anthropic 官方 API Key（可选，启用混合路由时需要）

**关键代码**：[src/middleware/auth.ts](src/middleware/auth.ts)

### 3. 会话管理（两层机制）

项目实现了智能会话管理，确保多轮对话的上下文连续性：

**优先方案 - 真实会话**：
- 使用 `convertAnthropicToSiderAsync()` 从 Sider 获取完整会话历史
- 会话 ID 通过 `cid` query 参数或 `X-Conversation-ID` header 传递
- 在 SSE `message_start` 事件中捕获真实的 `cid`、`user_message_id`、`assistant_message_id`
- 存储在 `siderSessionStore`（内存 Map）

**降级方案 - 本地简化会话**：
- 当获取真实历史失败时，使用 `convertAnthropicToSider()`
- 从请求中提取最后用户消息和最近历史（最多 2 轮）
- 使用 `getNextParentMessageId()` 获取父消息 ID

**特殊会话 - 连续对话**：
- 当检测到多轮对话但无明确会话 ID 时，自动创建 `continuous-conversation` 会话
- 通过 `getOrCreateContinuousSession()` 维护连续对话状态
- 自动更新 `assistantMessageId` 作为下次请求的 `parent_message_id`

**关键文件**：
- [src/utils/sider-session-manager.ts](src/utils/sider-session-manager.ts) - 真实会话管理
- [src/utils/conversation-manager.ts](src/utils/conversation-manager.ts) - 本地会话管理（降级）
- [src/utils/request-converter.ts](src/utils/request-converter.ts) - 转换逻辑
- [src/utils/sider-conversation.ts](src/utils/sider-conversation.ts) - Sider 会话历史获取

### 4. API 流转流程

```
客户端请求 (Anthropic 格式)
    ↓
中间件认证 (Bearer Token = AUTH_TOKEN)
    ↓
路由引擎决策 (选择后端)
    ↓
    ├─→ Anthropic 路径:
    │   ├─ 使用 AnthropicApiAdapter
    │   ├─ 直接调用 Anthropic API
    │   └─ 返回响应
    │
    └─→ Sider 路径:
        ├─ 请求转换 (Anthropic → Sider)
        │  ├─ convertAnthropicToSiderAsync() [优先：多轮对话]
        │  └─ convertAnthropicToSider() [降级：新会话]
        ├─ Sider API 调用 (SSE 流式)
        ├─ SSE 事件解析
        │  ├─ credit_info → 配额信息
        │  ├─ message_start → 捕获会话 ID ⭐
        │  ├─ reasoning_content → 推理内容
        │  ├─ text → 最终文本
        │  └─ tool_call_* → 工具调用事件
        ├─ 响应转换 (Sider → Anthropic)
        └─ 客户端响应 + 会话信息头
```

### 5. SSE 流式响应处理

**Sider API 的 SSE 事件类型** ([src/utils/sider-client.ts:175-377](src/utils/sider-client.ts)):

| 事件类型 | 描述 | 处理逻辑 |
|---------|------|---------|
| `credit_info` | 配额信息 | 记录日志，不处理 |
| `message_start` | 消息开始 | **捕获 `cid`、`user_message_id`、`assistant_message_id`** 并保存到会话管理器 |
| `reasoning_content` | 推理过程 | 保存到 `reasoningParts[]`（think 模型专用） |
| `text` | 文本内容 | 保存到 `textParts[]`（主要响应内容） |
| `tool_call_start` | 工具调用开始 | 初始化工具调用记录 |
| `tool_call_progress` | 工具调用进行中 | 更新工具状态 |
| `tool_call_result` | 工具调用结果 | 保存最终结果和错误信息 |

**客户端流式响应** ([src/routes/messages.ts:242-346](src/routes/messages.ts)):

当客户端请求 `stream: true` 时，返回标准 Anthropic SSE 格式：
```
data: {"type":"message_start",...}
data: {"type":"content_block_start",...}
data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}
...
data: {"type":"content_block_stop",...}
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},...}
data: {"type":"message_stop"}
```

**注意**：当前实现为按词分割发送（每 150ms 一个词），用于演示流式效果。

### 6. 模型映射系统

**独立配置**：[src/config/models.ts](src/config/models.ts)

支持的模型及映射关系：

| Anthropic 模型 | Sider 模型 | 说明 |
|---------------|-----------|------|
| `claude-3.7-sonnet` | `claude-3.7-sonnet` | Claude 3.7 标准版 |
| `claude-3-7-sonnet` | `claude-3.7-sonnet-think` | Claude 3.7 思考版 |
| `claude-4-sonnet` | `claude-4-sonnet` | Claude 4 标准版 |
| `claude-4-sonnet-think` | `claude-4-sonnet-think` | Claude 4 思考版 |
| `claude-4.5-sonnet` | `claude-4.5-sonnet` | Claude 4.5 标准版 |
| `claude-4.5-sonnet-think` | `claude-4.5-sonnet-think` | Claude 4.5 思考版 ⭐ |
| `claude-haiku-4.5` | `claude-haiku-4.5` | Haiku 4.5 标准版 |
| `claude-4.1-opus` | `claude-4.1-opus` | Opus 4.1 标准版 |

**默认降级**：未知模型映射到 `claude-3.7-sonnet-think`

**API 端点**：`GET /v1/models` - 列出所有支持的模型

### 7. 工具调用功能

**状态**：✅ 完整实现并启用

**工具转换** ([src/utils/request-converter.ts:333-398](src/utils/request-converter.ts)):

```typescript
// Anthropic 工具格式 → Sider 工具格式
buildSafeToolsConfig(anthropicRequest) → SiderTools

// 支持的工具映射
{
  'web_search' → 'search',
  'create_image' → 'create_image',
  'web_browse' → 'web_browse'
}
```

**工具调用流程**：
```
1. tool_call_start → 初始化工具记录 (toolResults[])
2. tool_call_progress → 更新状态和进度
3. tool_call_result → 保存最终结果或错误
4. 转换为 Anthropic 格式返回客户端
```

**关键数据结构**：
```typescript
interface SiderParsedResponse {
  reasoningParts: string[];
  textParts: string[];
  toolResults?: ToolResult[];  // 工具调用结果数组
  model: string;
  conversationId?: string;
  messageIds?: { user: string; assistant: string };
}
```

### 8. 模块职责

**核心路由**：
- [src/routes/messages-hybrid.ts](src/routes/messages-hybrid.ts) - **混合路由主入口** ⭐
  - `POST /v1/messages` - 主 API 端点（智能路由到 Sider 或 Anthropic）
  - `POST /v1/messages/count_tokens` - Token 计数
  - `GET /v1/messages/conversations` - 本地会话统计
  - `POST /v1/messages/conversations/cleanup` - 清理过期本地会话
  - `GET /v1/messages/sider-sessions` - Sider 会话统计
  - `POST /v1/messages/sider-sessions/cleanup` - 清理过期 Sider 会话

**其他路由**:
- [src/routes/models.ts](src/routes/models.ts) - `GET /v1/models` - 列出支持的模型
- [src/routes/health.ts](src/routes/health.ts) - `GET /health` - 健康检查
- [src/routes/complete.ts](src/routes/complete.ts) - `POST /v1/complete` - 文本补全（遗留端点）

**类型定义**:
- [src/types/anthropic.ts](src/types/anthropic.ts) - Anthropic API 完整类型（messages, tools, streaming）
- [src/types/sider.ts](src/types/sider.ts) - Sider API 类型（request, SSE response）

**工具函数**:
- [src/utils/request-converter.ts](src/utils/request-converter.ts) - 请求格式转换（Anthropic → Sider）
- [src/utils/response-converter.ts](src/utils/response-converter.ts) - 响应格式转换（Sider → Anthropic）
- [src/utils/sider-client.ts](src/utils/sider-client.ts) - Sider HTTP 客户端和 SSE 解析
- [src/utils/sider-conversation.ts](src/utils/sider-conversation.ts) - 会话历史获取

**路由和适配器** ⭐ 新增:
- [src/routing/router-engine.ts](src/routing/router-engine.ts) - 智能路由引擎
- [src/adapters/anthropic-adapter.ts](src/adapters/anthropic-adapter.ts) - Anthropic API 适配器

**配置文件**:
- [src/config/models.ts](src/config/models.ts) - 模型映射配置
- [src/config/backends.ts](src/config/backends.ts) - 后端配置管理 ⭐ 新增

**中间件**:
- [src/middleware/auth.ts](src/middleware/auth.ts) - Bearer Token 认证（双层认证支持）

## 开发约束和规范

### 必须遵守（来自 [shrimp-rules.md](shrimp-rules.md)）

**架构约束**：
- ✅ 必须使用 Hono 框架和 Bun/Deno 运行时
- ✅ 保持 `/v1/messages` 端点签名不变
- ✅ 保持 Anthropic API 完全兼容
- ✅ 混合路由必须透明，客户端无感知

**会话保持规范**：
- ✅ 优先使用 `convertAnthropicToSiderAsync()` 获取真实会话历史
- ✅ 失败时自动降级到 `convertAnthropicToSider()`
- ✅ 在 `message_start` 事件中捕获真实的 `cid`、`user_message_id`、`assistant_message_id`
- ✅ 调用 `saveSiderSession()` 保存会话信息到内存
- ✅ 响应中包含会话信息 headers（X-Conversation-ID、X-Assistant-Message-ID、X-User-Message-ID）
- ✅ 会话绑定后端（sessionSticky: true 时）

**工具调用规范**：
- ✅ `buildSafeToolsConfig()` 已启用完整工具转换
- ✅ 支持 Anthropic 标准的 `tools` 和 `tool_choice` 参数
- ✅ 完整的工具调用处理链路（start → progress → result）
- ✅ 工具调用错误的标准化处理

**AI 决策优先级**：
1. 保持 Anthropic API 兼容性（绝不破坏 Claude Code 集成）
2. 维护会话保持功能（确保多轮对话正常）
3. 实现工具调用功能（支持 Claude Code 的工具使用）
4. 混合路由系统的稳定性和透明性 ⭐ 新增
5. 保持 copilot-api 架构一致性
6. 维护 Sider API 调用稳定性

### 严禁事项

- ❌ 破坏 Anthropic API 兼容性
- ❌ 删除会话管理相关文件
- ❌ 硬编码会话 ID
- ❌ 忽略工具调用的错误处理
- ❌ 修改现有 `/v1/messages` 端点签名
- ❌ 在路由决策中引入破坏性变更 ⭐ 新增

## 环境配置

创建 `.env` 文件：

```bash
# 服务器配置
PORT=4141
NODE_ENV=development

# 客户端认证
AUTH_TOKEN=my-secret-api-key-2025       # 客户端认证 Token

# Sider AI API 配置
SIDER_API_URL=https://sider.ai/api/chat/v1/completions
SIDER_AUTH_TOKEN=eyJhbGci...            # Sider AI JWT Token

# Anthropic API 配置（可选，启用混合路由时需要）
ANTHROPIC_API_KEY=sk-ant-...            # Anthropic 官方 API Key

# 可选配置
LOG_LEVEL=info                          # debug | info | warn | error
REQUEST_TIMEOUT=30000                   # 30 秒
```

**Claude Code 集成**（见 [CLAUDE_CODE_SETUP.md](CLAUDE_CODE_SETUP.md)）：

```bash
# Bun 本地服务器
export ANTHROPIC_BASE_URL=http://localhost:4141
export ANTHROPIC_AUTH_TOKEN=my-secret-api-key-2025  # 使用 AUTH_TOKEN
export ANTHROPIC_MODEL=claude-4.5-sonnet-think

# Deno Deploy 生产环境
export ANTHROPIC_BASE_URL=https://your-deno-deploy-url.deno.dev
export ANTHROPIC_AUTH_TOKEN=my-secret-api-key-2025
export ANTHROPIC_MODEL=claude-4.5-sonnet-think
```

## 关键实现细节

### 混合路由决策逻辑 ⭐ 新增

路由引擎根据以下因素决策：

1. **后端启用状态**: 检查 `.backend.config.json` 中的 `enabled` 标志
2. **模型支持**: 检查请求的模型是否在后端的 `supportedModels` 列表中
3. **工具调用**: 检查是否需要工具调用（某些工具可能只在特定后端支持）
4. **会话粘性**: 如果 `sessionSticky: true`，已有会话将绑定到同一后端
5. **路由策略**:
   - `priority`: 按 `priority` 字段选择（数字越小优先级越高）
   - `round-robin`: 轮询选择
   - `model-based`: 基于模型名称选择

**关键代码**: [src/routing/router-engine.ts](src/routing/router-engine.ts)

### 会话 ID 获取流程

1. 客户端请求时可选提供 `cid`（query 参数或 `X-Conversation-ID` header）
2. 如果提供了 `cid`，尝试从 `siderSessionStore` 获取会话信息
3. **如果启用会话粘性，检查会话绑定的后端** ⭐ 新增
4. 如果找到，使用 `getNextParentMessageId()` 获取正确的 `parent_message_id`
5. 如果多轮对话但无 `cid`，自动创建 `continuous-conversation` 会话
6. 在 SSE `message_start` 事件中，捕获 Sider 返回的真实 `cid`、`user_message_id`、`assistant_message_id`
7. 调用 `saveSiderSession()` 保存新的会话信息到内存
8. **记录会话使用的后端（用于会话粘性）** ⭐ 新增
9. 在响应 headers 中返回会话信息给客户端

### 工具调用数据流

```typescript
// 1. 客户端请求包含工具定义
{
  "tools": [
    {
      "name": "web_search",
      "description": "Search the web",
      "input_schema": { "type": "object", ... }
    }
  ]
}

// 2. 转换为 Sider 格式
buildSafeToolsConfig() → {
  "auto": ["search"],
  "search": { "enabled": true, "max_results": 10 }
}

// 3. SSE 事件序列
message_start → 捕获会话信息
tool_call_start → 初始化工具调用记录
tool_call_progress → 更新状态（可选）
tool_call_result → 保存结果或错误
text → 最终文本响应

// 4. 转换回 Anthropic 格式
{
  "content": [
    {
      "type": "tool_use",
      "id": "toolu_xxx",
      "name": "web_search",
      "input": { ... }
    },
    {
      "type": "text",
      "text": "Based on the search results..."
    }
  ]
}
```

## 当前状态

**已完整实现**：
- ✅ API 格式转换（Anthropic ↔ Sider）
- ✅ 混合路由系统（智能选择 Sider 或 Anthropic） ⭐ 新增
- ✅ 双层会话管理（真实会话 + 本地降级）
- ✅ SSE 流式响应解析（完整事件类型）
- ✅ 双层认证中间件（AUTH_TOKEN + SIDER_AUTH_TOKEN）
- ✅ 工具调用功能（完整支持）
- ✅ 模型映射系统（10+ 模型）
- ✅ Token 计数端点
- ✅ 错误处理和日志
- ✅ Deno 运行时支持

**未实现**：
- ⏳ CLI 功能（citty 框架已导入但未使用）
- ⏳ 精确 Token 计算（gpt-tokenizer 已导入但未使用，当前为粗略估算）

**已知限制**：
- ⚠️ 流式响应为按词模拟发送，非真正实时流式（功能正常，但非最优性能）
- ⚠️ 会话存储为内存 Map，重启后丢失（可升级为 Redis）
- ⚠️ Token 计数为估算（JSON 长度 ÷ 4），非精确值
- ⚠️ 混合路由的会话粘性依赖内存存储 ⭐ 新增

## 调试技巧

1. **查看会话状态**：
   ```bash
   curl http://localhost:4141/v1/messages/sider-sessions
   curl http://localhost:4141/v1/messages/conversations
   ```

2. **查看后端配置** ⭐ 新增：
   ```bash
   # 检查 .backend.config.json
   cat .backend.config.json

   # 查看路由决策日志
   LOG_LEVEL=debug bun run dev
   ```

3. **启用详细日志**：设置 `LOG_LEVEL=debug` 在 `.env` 中

4. **检查会话 ID 传递**：在响应 headers 中查看 `X-Conversation-ID`

5. **测试混合路由** ⭐ 新增：
   ```bash
   # 请求会被路由到配置的后端
   curl -X POST http://localhost:4141/v1/messages \
     -H "Authorization: Bearer my-secret-api-key-2025" \
     -H "Content-Type: application/json" \
     -d '{"model":"claude-3.7-sonnet","messages":[{"role":"user","content":"Hello"}],"max_tokens":1024}'

   # 检查响应头中的 X-Backend-Used 了解使用了哪个后端
   ```

6. **测试多轮对话**：
   ```bash
   # 第一轮（获取 cid）
   curl -X POST http://localhost:4141/v1/messages \
     -H "Authorization: Bearer my-secret-api-key-2025" \
     -H "Content-Type: application/json" \
     -d '{"model":"claude-3.7-sonnet","messages":[{"role":"user","content":"Hello"}],"max_tokens":1024}' \
     -v 2>&1 | grep -i "X-Conversation-ID"

   # 第二轮（使用 cid）
   curl -X POST "http://localhost:4141/v1/messages?cid=<获取的cid>" \
     -H "Authorization: Bearer my-secret-api-key-2025" \
     -H "Content-Type: application/json" \
     -d '{"model":"claude-3.7-sonnet","messages":[{"role":"user","content":"Continue"}],"max_tokens":1024}'
   ```

7. **测试工具调用**：
   ```bash
   curl -X POST http://localhost:4141/v1/messages \
     -H "Authorization: Bearer my-secret-api-key-2025" \
     -H "Content-Type: application/json" \
     -d '{
       "model":"claude-3.7-sonnet",
       "messages":[{"role":"user","content":"Search for AI news"}],
       "tools":[{"name":"web_search","description":"Search the web","input_schema":{"type":"object"}}],
       "max_tokens":1024
     }'
   ```

## 参考文档

**核心文档**：
- [README.md](README.md) - 项目介绍和快速开始
- [shrimp-rules.md](shrimp-rules.md) - AI 代理开发规范和约束 ⭐ 重要

**集成指南**：
- [CLAUDE_CODE_SETUP.md](CLAUDE_CODE_SETUP.md) - Claude Code CLI 集成指南
- [docs/new-api-integration.md](docs/new-api-integration.md) - New-API 集成指南

**部署文档**：
- [DENO-DEPLOY.md](DENO-DEPLOY.md) - Deno Deploy 部署指南
- [docs/deno-deploy-final-guide.md](docs/deno-deploy-final-guide.md) - 最终部署指南 ⭐

**测试文档**：
- [docs/TEST-SUMMARY-2025-10-17.md](docs/TEST-SUMMARY-2025-10-17.md) - 最新测试总结（100% 通过）
- [docs/API-TESTING.md](docs/API-TESTING.md) - 完整测试指南

**故障排除**：
- [docs/claude-code-fix.md](docs/claude-code-fix.md) - Claude Code 集成问题修复
- [docs/new-api-troubleshooting.md](docs/new-api-troubleshooting.md) - New-API 401 错误解决

**技术分析**：
- [docs/LIMITATIONS.md](docs/LIMITATIONS.md) - 已知限制和解决方案
- [docs/feature-models-api.md](docs/feature-models-api.md) - Models API 功能说明
