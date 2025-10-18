# Sider2Claude

将 Sider AI 的 API 转换为 Anthropic API 格式，为 Claude Code CLI 提供完全兼容的接口服务。

**技术栈**: Hono + Bun + TypeScript

## ✨ 核心特性

- 🔄 **完美API转换**: 100% 兼容 Anthropic API 格式，支持 Claude Code CLI 集成，目前不支持 Claude Code CLI工具调用 原因：Sider API 不支持 Claude Code CLI 的工具，限制了
- 🎯 **智能会话管理**: 自动捕获和管理 Sider 真实会话ID，确保对话连续性
- 💬 **双重会话机制**: 支持真实 Sider 会话 + 本地上下文推断，提供最佳用户体验
- 🛠️ **完整工具支持**: 支持 Anthropic 工具调用格式和 Sider AI 原生功能
- 🚀 **流式响应**: 原生支持 SSE 流式输出，兼容所有 Anthropic 客户端
- 🔐 **双层认证**: 客户端使用 AUTH_TOKEN 认证,后端使用 SIDER_AUTH_TOKEN 访问 Sider AI,提供企业级安全保障
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
cd sider2claude
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

# 认证配置 (双层认证)
# AUTH_TOKEN: 客户端使用的认证 Token (自定义字符串)
AUTH_TOKEN=my-secret-api-key-2025

# Sider AI API 配置
SIDER_API_URL=https://sider.ai/api/chat/v1/completions
# SIDER_AUTH_TOKEN: 从 sider.ai 获取的 JWT Token (以 eyJhbGci 开头)
SIDER_AUTH_TOKEN=eyJhbGci...

# 可选配置
LOG_LEVEL=info
REQUEST_TIMEOUT=30000
```

**双层认证架构**：
```
客户端 (使用 AUTH_TOKEN)
    ↓
Sider2Claude API (验证 AUTH_TOKEN)
    ↓
Sider AI (使用 SIDER_AUTH_TOKEN)
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

Sider2Claude 自动从 Sider API 响应中捕获真实的会话信息，无需手动管理：

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
export ANTHROPIC_AUTH_TOKEN=my-secret-api-key-2025  # 使用你配置的 AUTH_TOKEN
export ANTHROPIC_MODEL=claude-3.7-sonnet
```

**注意**: 使用双层认证时，`ANTHROPIC_AUTH_TOKEN` 应设置为你在 `.env` 中配置的 `AUTH_TOKEN` 值。

### 配置文件方式

创建 `~/.claude/settings.json`:

```json
{
  "anthropic_base_url": "http://localhost:4141",
  "anthropic_auth_token": "my-secret-api-key-2025",
  "anthropic_model": "claude-3.7-sonnet"
}
```

### 验证集成

配置完成后，Claude Code 将自动使用我们的 API 服务，享受 Sider AI 的强大功能。

## 🔌 与 New-API 集成

### 快速配置 (3 步)

#### 1️⃣ 在 New-API 中添加渠道

```
渠道配置:
├─ 类型: Anthropic Claude
├─ 名称: Sider2Claude
├─ Base URL: https://deno-sider2claude.deno.dev
├─ 密钥: my-secret-api-key-2025  ← 使用 AUTH_TOKEN
├─ 优先级: 1
└─ 状态: ✅ 启用
```

**重要提示 (双层认证)**:
- ✅ Base URL **不要包含** `/v1` 或其他路径
- ✅ 密钥填写 AUTH_TOKEN (客户端认证 Token)
- ✅ SIDER_AUTH_TOKEN 在服务器端环境变量中配置
- ✅ 保存后点击 **测试** 按钮验证配置

#### 2️⃣ 在 New-API 中创建令牌

1. 进入 **令牌管理** → **添加令牌**
2. 设置名称、额度和过期时间
3. (可选) 绑定到 Sider2Claude 渠道
4. **保存** 并复制生成的 Token (`sk-xxx...`)

#### 3️⃣ 使用 New-API Token 调用

```bash
# 使用 New-API 生成的 Token (sk-xxx...)
curl -X POST https://your-new-api.com/v1/chat/completions \
  -H "Authorization: Bearer sk-xxxxx..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3.7-sonnet",
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

**认证流程 (双层认证)**:
```
客户端 (使用 sk-xxx New-API Token)
    ↓
New-API (使用 AUTH_TOKEN)
    ↓
Sider2Claude (验证 AUTH_TOKEN)
    ↓
Sider AI (使用 SIDER_AUTH_TOKEN)
```

### 常见问题: 401 missing authorization header

**问题**: 在 New-API 中测试渠道时返回 401 错误

**原因**: 混淆了 New-API Token、AUTH_TOKEN 和 SIDER_AUTH_TOKEN

**解决方案 (双层认证)**:
- ❌ **错误**: 客户端直接使用 SIDER_AUTH_TOKEN (`eyJhbGci...`)
- ✅ **正确**: 客户端使用 New-API Token (`sk-xxx...`)
- ✅ **正确**: AUTH_TOKEN 配置在 New-API 渠道的"密钥"字段
- ✅ **正确**: SIDER_AUTH_TOKEN 配置在服务器端环境变量

**详细文档**:
- [New-API 集成指南](docs/new-api-integration.md)
- [配置对比说明](docs/new-api-config-comparison.md)
- [快速参考卡](docs/new-api-quick-reference.md)

## 🛠️ 开发指南

### 项目结构

```
Sider2Claude/
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

### Deno 本地测试 🦕

在部署到 Deno Deploy 之前,可以在本地测试 Deno 版本:

**安装 Deno**:
```powershell
# Windows PowerShell
irm https://deno.land/install.ps1 | iex

# 或使用安装脚本
.\scripts\install-deno.ps1
```

**启动 Deno 服务器** (端口 4142):
```bash
cd deno
start-local.bat    # Windows

# 或使用 deno task
deno task dev
```

**运行 Deno 测试**:
```bash
bun run test/02-deno-local.test.ts
```

**快速指南**: [docs/deno-quickstart.md](docs/deno-quickstart.md)
**完整配置**: [DENO-LOCAL-SETUP.md](DENO-LOCAL-SETUP.md)

### 测试套件包含

- ✅ 健康检查测试 (2 个)
- ✅ 基础消息 API 测试 (4 个)
- ✅ 会话保持测试 (3 个)
- ✅ 流式响应测试 (3 个)
- ✅ Token 计数测试 (5 个)
- ✅ **新增**: Deno 本地测试 (4 个)
- ✅ **新增**: Models API 测试 (10个模型)

**总计**: 21+ 个测试用例

### 测试文档

- 📊 [最新测试总结](docs/TEST-SUMMARY-2025-10-17.md) ⭐ **推荐** - 100% 通过
- 📋 [Deno Deploy 测试报告](docs/test-report-deno-deploy-2025-10-17.md) - 完整测试结果
- 🔧 [New-API 故障排除](docs/new-api-troubleshooting.md) - 401 错误解决方案
- 📖 [完整测试指南](docs/API-TESTING.md)
- 🐛 [测试结果分析](docs/TESTING-RESULTS.md)
- 🦕 [Deno 测试环境](docs/deno-setup-complete.md)
- 🎯 [Models API 功能](docs/feature-models-api.md)

## ☁️ 部署选项

本项目支持多种部署平台，可以根据需求选择最适合的方案：

### 选项 1: Railway（当前生产环境）⭐⭐⭐⭐⭐

**Railway 部署**: https://your-app-name.up.railway.app

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

**状态**: ✅ 代码已就绪，支持双层认证，可立即部署

**优势**：
- ✅ 全球 35+ 边缘节点，超低延迟
- ✅ 快速冷启动（~50-200ms）
- ✅ 更高免费额度（100万请求/月）
- ✅ 自动扩展和 HTTPS
- ✅ 支持双层认证架构

**快速部署**：
```bash
# 1. 访问 Deno Deploy
https://dash.deno.com/new

# 2. 连接 GitHub 仓库
# 3. 设置入口文件: deno/main.ts
# 4. 添加环境变量:
#    - AUTH_TOKEN=my-secret-api-key-2025
#    - SIDER_AUTH_TOKEN=eyJhbGci...
#    - SIDER_API_URL=https://sider.ai/api/chat/v1/completions
#    - LOG_LEVEL=info
# 5. 点击 Deploy
```

详细说明请参考：
- [Deno Deploy 最终部署指南](docs/deno-deploy-final-guide.md) ⭐ **推荐**
- [部署修复说明](DEPLOY-FIX.md)
- [Deno Deploy 部署指南](DENO-DEPLOY.md)
- [Deno 版本 README](deno/README.md)
- [Deno 迁移完成报告](docs/DENO-MIGRATION-COMPLETED.md)

### 选项 3: 其他平台

- **Vercel**: 需要配置 Node.js 运行时（不推荐，Serverless 限制）
- **Fly.io**: 支持 Bun，配置简单
- **Self-hosted**: VPS 部署，完全控制

### 当前部署状态

**Railway 生产环境** ⭐: https://your-app-name.up.railway.app

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

### Claude Code 集成问题 ⚠️

#### 问题: `API Error (500 {"text":"Error: Sider API error: 400 Bad Request"})`

**症状**:
- Claude Code 报告 400 或 500 错误
- 请求不断重试失败
- 使用 `claude-4.5-sonnet-think` 或其他模型

**根本原因**: Token 配置问题(不是模型名称问题!)

**快速修复**:

1. **检查 Token 配置**:
   ```powershell
   # Windows PowerShell
   $env:ANTHROPIC_AUTH_TOKEN
   ```

   ❌ 如果显示 "dummy" 或为空 → **这就是问题所在!**

   ✅ 应该是以 `eyJhbGci` 开头的 JWT Token

2. **使用修复脚本** (推荐):
   ```powershell
   # 自动检测和修复 Token 配置
   .\scripts\fix-claude-code.ps1
   ```

3. **手动获取真实 Sider Token**:
   - 访问 https://sider.ai 并登录
   - 打开开发者工具 (F12) → Network 标签
   - 发送一条消息
   - 找到 `completions` 请求
   - 复制 Authorization header 中的 JWT Token

4. **更新环境变量**:
   ```powershell
   $env:ANTHROPIC_AUTH_TOKEN="eyJhbGci... (你的真实 Token)"
   ```

5. **重启 Claude Code** 并测试

**详细指南**: [docs/claude-code-fix.md](docs/claude-code-fix.md)

**已验证**: 所有 10 个模型(包括 `claude-4.5-sonnet-think`)在使用真实 Token 时 100% 工作 ✅

---

### 其他常见问题

1. **认证失败 (403 Forbidden)**
   - 检查 `SIDER_AUTH_TOKEN` 是否正确
   - 确认 Token 是否过期(Sider Token 通常有效期 30 天)
   - 使用 `curl` 测试 Token 有效性:
     ```bash
     curl -X POST https://deno-sider2claude.deno.dev/v1/messages \
       -H "Authorization: Bearer YOUR_TOKEN" \
       -H "Content-Type: application/json" \
       -d '{"model":"claude-3.7-sonnet","messages":[{"role":"user","content":"test"}],"max_tokens":50}'
     ```

2. **模型不存在 (404)**
   - 检查可用模型列表:
     ```bash
     curl https://deno-sider2claude.deno.dev/v1/models
     ```
   - 使用已验证的模型名称

3. **会话不连续**
   - 检查是否正确传递 `X-Conversation-ID` 和 `X-Parent-Message-ID`
   - 查看服务器日志确认会话状态
   - Claude Code 通常会自动管理会话

4. **响应格式错误**
   - 确认请求格式符合 Anthropic API 规范
   - 检查 Sider API 服务状态
   - 查看服务器日志获取详细错误信息

### 调试模式

**本地服务器调试**:
```bash
# 1. 启动本地服务器
bun run dev

# 2. 配置 Claude Code 使用本地服务器
$env:ANTHROPIC_BASE_URL="http://localhost:4141"
$env:ANTHROPIC_AUTH_TOKEN="your_real_token"

# 3. 观察终端日志查看详细信息
```

**启用详细日志**:
```bash
LOG_LEVEL=debug
```

### 获取帮助

如果遇到问题，请：
1. 查看 [故障排除文档](docs/claude-code-fix.md)
2. 检查服务器日志
3. 确认环境配置
4. 运行 `.\scripts\fix-claude-code.ps1` 自动诊断
5. 提交 Issue 并附上错误日志

## 📄 许可证

MIT License

## 🙏 致谢

感谢开源社区的支持和贡献。

## 🤝 贡献

欢迎提交 Issue 和 Pull Request 来改进项目！

---

**Sider2Claude** - 让 Sider AI 与 Claude Code 完美融合!!! 🚀
