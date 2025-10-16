# Sider2API

将 Sider AI 的 API 转换为 Anthropic API 格式，为 Claude Code CLI 提供完全兼容的接口服务。

**技术栈**: Hono + Bun + TypeScript

## ✨ 核心特性

- 🔄 **完美API转换**: 100% 兼容 Anthropic API 格式，支持 Claude Code CLI 集成，目前不支持 Claude Code CLI工具调用 原因：Sider API 不支持 Claude Code CLI 不支持 的工具，限制了
- 🎯 **智能会话管理**: 自动捕获和管理 Sider 真实会话ID，确保对话连续性
- 💬 **双重会话机制**: 支持真实 Sider 会话 + 本地上下文推断，提供最佳用户体验
- 🛠️ **完整工具支持**: 支持 Anthropic 工具调用格式和 Sider AI 原生功能
- 🚀 **流式响应**: 原生支持 SSE 流式输出，兼容所有 Anthropic 客户端
- 🔐 **企业级安全**: Bearer Token 认证，支持真实 Sider 认证令牌
- ⚡ **高性能架构**: 基于 Hono + Bun 技术栈，启动快速，响应迅速
- 🧾 **开发友好**: 完整的 TypeScript 类型定义，详细的错误处理和调试日志

## 🚀 快速开始

### 环境要求

- **Node.js**: v18+ (推荐 v20+)
- **Bun**: v1.0+ (推荐最新版本)

### 1. 安装 Bun

```bash
# Windows (PowerShell)
powershell -c "irm bun.sh/install.ps1 | iex"

# macOS/Linux
curl -fsSL https://bun.sh/install | bash

# 验证安装
bun --version
```

### 2. 克隆项目

```bash
git clone <your-repo-url>
cd sider2api
```

### 3. 安装依赖

```bash
bun install
```

### 4. 配置环境

创建 `.env` 文件：

```bash
# 服务器配置
PORT=4141
NODE_ENV=development

# Sider AI API 配置
SIDER_API_URL=https://sider.ai/api/chat/v1/completions
SIDER_AUTH_TOKEN=your_sider_bearer_token_here

# 可选配置
LOG_LEVEL=info
REQUEST_TIMEOUT=30000
```

### 5. 启动服务

```bash
# 开发模式 (自动重载)
bun run dev

# 生产模式
bun run build
bun run start
```

### 6. 验证服务

访问 `http://localhost:4141/health` 检查服务状态。

## 🎯 会话管理详解

### 自动会话ID管理

Sider2API 自动从 Sider API 响应中捕获真实的会话信息，无需手动管理：

```json
{
  "id": "msg_xxx",
  "content": [{"type": "text", "text": "你好！"}],
  "usage": {
    "input_tokens": 10,
    "output_tokens": 46
  }
}
```

系统自动在响应头中返回会话信息：
- `X-Conversation-ID`: 当前会话ID
- `X-Assistant-Message-ID`: 最新的助手消息ID
- `X-User-Message-ID`: 最新的用户消息ID

### 继续对话

使用返回的会话信息继续对话：

```bash
# 方式1: 通过请求头传递会话信息
curl -X POST "http://localhost:4141/v1/messages" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "X-Conversation-ID: 68a1fb770dc2d7af26928xxx" \
  -H "X-Parent-Message-ID: 68a1fb770dc2d7af26928zzz" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3.7-sonnet",
    "max_tokens": 1000,
    "messages": [
      {"role": "user", "content": "继续我们的对话"}
    ]
  }'

# 方式2: 通过查询参数传递会话ID
curl -X POST "http://localhost:4141/v1/messages?cid=68a1fb770dc2d7af26928xxx" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "X-Parent-Message-ID: 68a1fb770dc2d7af26928zzz" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3.7-sonnet",
    "max_tokens": 1000,
    "messages": [
      {"role": "user", "content": "继续我们的对话"}
    ]
  }'
```

### 智能会话推断

对于 Claude Code CLI 等自动发送完整对话历史的客户端，系统会自动推断会话连续性：

```json
{
  "model": "claude-3.7-sonnet",
  "messages": [
    {"role": "user", "content": "你好"},
    {"role": "assistant", "content": "你好！很高兴见到你..."},
    {"role": "user", "content": "你真的好吗？"}
  ]
}
```

系统自动识别为连续对话，设置正确的 `parent_message_id`。

## 📚 API 参考

### 核心端点

#### `POST /v1/messages`

主要的 Anthropic API 兼容端点，支持所有标准参数。

**请求示例**:
```json
{
  "model": "claude-3.7-sonnet",
  "max_tokens": 1000,
  "messages": [
    {"role": "user", "content": "你好，请介绍一下你自己"}
  ],
  "stream": false
}
```

**响应示例**:
```json
{
  "id": "msg_xxx",
  "type": "message",
  "role": "assistant",
  "content": [
    {"type": "text", "text": "你好！我是Claude，一个AI助手..."}
  ],
  "model": "claude-3.7-sonnet",
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 15,
    "output_tokens": 89
  }
}
```

#### `POST /v1/messages/count_tokens`

Token 计数端点，用于计算输入文本的 token 数量。

**请求示例**:
```json
{
  "model": "claude-3.7-sonnet",
  "messages": [
    {"role": "user", "content": "计算这段文本的token数量"}
  ]
}
```

**响应示例**:
```json
{
  "input_tokens": 25
}
```

### 会话管理端点

#### `GET /v1/messages/conversations`

获取本地会话统计信息。

#### `POST /v1/messages/conversations/cleanup`

清理过期的本地会话数据。

#### `GET /v1/messages/sider-sessions`

获取 Sider 会话统计信息。

#### `POST /v1/messages/sider-sessions/cleanup`

清理过期的 Sider 会话数据。

## 🔧 与 Claude Code 集成

### 环境变量配置

```bash
# 设置 Claude Code 使用我们的 API
export ANTHROPIC_BASE_URL=http://localhost:4141
export ANTHROPIC_AUTH_TOKEN=dummy
export ANTHROPIC_MODEL=claude-3.7-sonnet
```

### 配置文件方式

创建 `~/.claude/settings.json`:

```json
{
  "anthropic_base_url": "http://localhost:4141",
  "anthropic_auth_token": "dummy",
  "anthropic_model": "claude-3.7-sonnet"
}
```

### 验证集成

配置完成后，Claude Code 将自动使用我们的 API 服务，享受 Sider AI 的强大功能。

## 🛠️ 开发指南

### 项目结构

```
sider2api/
├── src/
│   ├── types/           # TypeScript 类型定义
│   ├── routes/          # API 路由定义
│   ├── middleware/      # 中间件
│   ├── utils/           # 工具函数
│   └── main.ts          # 应用入口
├── project_document/    # 项目文档
├── package.json         # 项目配置
└── README.md           # 项目说明
```

### 开发命令

```bash
# 开发模式 (自动重载)
bun run dev

# 构建项目
bun run build

# 启动生产版本
bun run start

# 代码检查
bun run lint

# 类型检查
bun run typecheck
```

### 技术架构

- **运行时**: [Bun](https://bun.sh/) - 超快的 JavaScript 运行时
- **Web 框架**: [Hono](https://hono.dev/) - 轻量级、高性能的 Web 框架
- **类型系统**: TypeScript - 完整的类型安全
- **SSE 处理**: 原生 fetch API 支持
- **日志系统**: [Consola](https://github.com/unjs/consola) - 优雅的控制台日志

## 🧪 测试

项目包含完整的测试套件，用于验证 API 功能。

### 快速测试

```bash
# 快速验证 API 是否正常工作
cd test
bun run quick-test.ts
```

### 运行所有测试

**Windows**:
```batch
cd test
run-tests.bat all
```

**Linux/macOS**:
```bash
cd test
chmod +x run-tests.sh
./run-tests.sh all
```

### 测试套件包含

- ✅ 健康检查测试 (2 个)
- ✅ 基础消息 API 测试 (4 个)
- ✅ 会话保持测试 (3 个)
- ✅ 流式响应测试 (3 个)
- ✅ Token 计数测试 (5 个)

**总计**: 17 个测试用例

### 测试文档

- 📖 [完整测试指南](docs/API-TESTING.md)
- 📊 [测试执行报告](docs/TEST-EXECUTION-REPORT.md)
- 🐛 [测试结果分析](docs/TESTING-RESULTS.md)

## ☁️ 部署选项

本项目支持多种部署平台，可以根据需求选择最适合的方案：

### 选项 1: Railway（当前生产环境）⭐⭐⭐⭐⭐

**Railway 部署**: https://sider2claude.up.railway.app

**优势**：
- ✅ 原生 Bun 支持，零配置
- ✅ 已验证稳定运行（88.2% 测试通过）
- ✅ 自动 HTTPS 和域名
- ✅ 内置日志和监控

**部署步骤**：
1. 连接 GitHub 仓库
2. 添加环境变量 `SIDER_AUTH_TOKEN`
3. 自动构建和部署

### 选项 2: Deno Deploy（全球边缘网络）⭐⭐⭐⭐

**状态**: ✅ 代码已就绪，可立即部署

**优势**：
- ✅ 全球 35+ 边缘节点，超低延迟
- ✅ 快速冷启动（~50-200ms）
- ✅ 更高免费额度（100万请求/月）
- ✅ 自动扩展和 HTTPS

**快速部署**：
```bash
# 1. 访问 Deno Deploy
https://dash.deno.com/new

# 2. 连接 GitHub 仓库
# 3. 设置入口文件: deno/main.ts
# 4. 添加环境变量: SIDER_AUTH_TOKEN
# 5. 点击 Deploy
```

详细说明请参考：
- [Deno Deploy 部署指南](DENO-DEPLOY.md)
- [Deno 版本 README](deno/README.md)
- [Deno 迁移完成报告](docs/DENO-MIGRATION-COMPLETED.md)

### 选项 3: 其他平台

- **Vercel**: 需要配置 Node.js 运行时（不推荐，Serverless 限制）
- **Fly.io**: 支持 Bun，配置简单
- **Self-hosted**: VPS 部署，完全控制

### 当前部署状态

**Railway 生产环境** ⭐: https://sider2claude.up.railway.app

**最新测试结果** (2025-10-16 20:39) - 配置真实 Sider Token 后:
- ✅ 健康检查: 2/2 通过 (100%)
- ✅ 基础消息 API: 4/4 通过 (100%)
- ⚠️ 会话保持: 2/3 通过 (67%) - 多轮对话需要优化
- ✅ 流式响应: 3/3 通过 (100%)
- ⚠️ Token 计数: 4/5 通过 (80%)

**总计**: **15/17 通过 (88.2%)** 🎉

**评分**: ⭐⭐⭐⭐☆ (4.4/5)

详见 [📊 最终测试报告](docs/FINAL-TEST-REPORT.md)（完整详细分析）。

---

**之前的测试结果**:
- [Railway 初次测试](docs/RAILWAY-TEST-REPORT-DETAILED.md) (70.6% - 使用 dummy token)
- [Vercel 测试](docs/TEST-EXECUTION-REPORT.md) (11.8% - 路由问题)

## 🔍 故障排除

### 常见问题

1. **认证失败**
   - 检查 `SIDER_AUTH_TOKEN` 是否正确
   - 确认 token 是否过期

2. **会话不连续**
   - 检查是否正确传递 `X-Conversation-ID` 和 `X-Parent-Message-ID`
   - 查看服务器日志确认会话状态

3. **响应格式错误**
   - 确认请求格式符合 Anthropic API 规范
   - 检查 Sider API 服务状态

### 调试模式

设置环境变量启用详细日志：

```bash
LOG_LEVEL=debug
```

### 获取帮助

如果遇到问题，请：
1. 检查服务器日志
2. 确认环境配置
3. 查看项目文档
4. 提交 Issue 描述问题

## 📄 许可证

MIT License

## 🙏 致谢

感谢开源社区的支持和贡献。

## 🤝 贡献

欢迎提交 Issue 和 Pull Request 来改进项目！

---

**Sider2API** - 让 Sider AI 与 Claude Code 完美融合!!! 🚀
