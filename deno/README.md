# Sider2Claude - Deno Deploy 版本

这是 Sider2Claude 的 Deno 兼容版本，支持智能路由，可以部署到 Deno Deploy 平台。

## ✨ 特性

- ✅ **智能路由**：自动选择 Sider AI 或 Anthropic API，成本和功能兼得
- ✅ **零配置部署**：直接部署到 Deno Deploy
- ✅ **全球边缘网络**：35+ 个边缘节点，超低延迟
- ✅ **快速冷启动**：~50-200ms 冷启动时间
- ✅ **高性能**：基于 Deno 运行时和 Hono 框架
- ✅ **完全兼容**：100% 兼容 Anthropic API

## 🎯 使用场景

### 场景 1: 只使用 Sider AI（免费）

适合个人开发者和测试场景。

**配置**：
- ✅ 配置 `SIDER_AUTH_TOKEN`
- ❌ 不配置 `ANTHROPIC_API_KEY`

**结果**：
- 所有请求使用 Sider AI
- 完全免费
- ⚠️ 不支持 Claude Code 的工具调用功能

### 场景 2: 只使用 Anthropic API（付费但功能完整）

适合需要完整功能的企业用户。

**配置**：
- ❌ 不配置 `SIDER_AUTH_TOKEN`
- ✅ 配置 `ANTHROPIC_API_KEY`

**结果**：
- 所有请求使用官方 Anthropic API
- 完整支持工具调用、MCP、子代理
- 💰 成本较高

### 场景 3: 混合使用（推荐）⭐

智能路由，自动选择最优后端。

**配置**：
- ✅ 同时配置 `SIDER_AUTH_TOKEN` 和 `ANTHROPIC_API_KEY`
- ✅ 设置 `PREFER_SIDER_FOR_CHAT=true`

**结果**：
- 简单对话 → Sider AI（免费）
- 工具调用/MCP/子代理 → Anthropic API（付费）
- 💰 节省 75-90% 成本
- ✅ 保留完整功能

## 🚀 快速开始

### 方式 1: 部署到 Deno Deploy（GitHub 集成）

1. **推送代码到 GitHub**
   ```bash
   git add .
   git commit -m "Add Deno Deploy support"
   git push
   ```

2. **访问 Deno Deploy Dashboard**
   - 打开：https://dash.deno.com/new
   - 连接你的 GitHub 仓库
   - 选择这个项目

3. **配置部署**
   - **入口文件**：`deno/main.ts`
   - **环境变量**（根据使用场景选择）：

   **场景 1: 只用 Sider AI**
   ```env
   # 必需配置
   SIDER_AUTH_TOKEN=eyJhbGci...
   AUTH_TOKEN=your-custom-auth-token

   # 可选配置
   SIDER_API_URL=https://sider.ai/api/chat/v1/completions
   PORT=8000
   LOG_LEVEL=info
   ```

   **场景 2: 只用 Anthropic API**
   ```env
   # 必需配置
   ANTHROPIC_API_KEY=sk-ant-...
   AUTH_TOKEN=your-custom-auth-token

   # 可选配置
   ANTHROPIC_BASE_URL=https://api.anthropic.com
   PORT=8000
   LOG_LEVEL=info
   ```

   **场景 3: 混合使用（推荐）⭐**
   ```env
   # 必需配置
   AUTH_TOKEN=your-custom-auth-token
   SIDER_AUTH_TOKEN=eyJhbGci...
   ANTHROPIC_API_KEY=sk-ant-...

   # 路由配置
   DEFAULT_BACKEND=sider
   AUTO_FALLBACK=true
   PREFER_SIDER_FOR_CHAT=true

   # 可选配置
   SIDER_API_URL=https://sider.ai/api/chat/v1/completions
   ANTHROPIC_BASE_URL=https://api.anthropic.com
   PORT=8000
   LOG_LEVEL=info
   DEBUG_ROUTING=false
   REQUEST_TIMEOUT=30000
   ```

4. **点击 Deploy**

### 方式 2: 使用 Deno CLI 部署

1. **安装 Deno**
   ```bash
   # Windows (PowerShell)
   irm https://deno.land/install.ps1 | iex

   # macOS/Linux
   curl -fsSL https://deno.land/install.sh | sh
   ```

2. **安装 deployctl**
   ```bash
   deno install -Arf jsr:@deno/deployctl
   ```

3. **部署**
   ```bash
   # 从项目根目录执行
   deployctl deploy \
     --project=sider2claude \
     --prod \
     deno/main.ts
   ```

### 方式 3: 本地开发测试

1. **安装 Deno**（见上方）

2. **配置环境变量**

   **Windows PowerShell**:
   ```powershell
   # 客户端认证 Token
   $env:AUTH_TOKEN="your-custom-auth-token"

   # 场景 1: 只用 Sider AI
   $env:SIDER_AUTH_TOKEN="eyJhbGci..."

   # 场景 2: 只用 Anthropic API
   $env:ANTHROPIC_API_KEY="sk-ant-..."

   # 场景 3: 混合使用（推荐）
   $env:SIDER_AUTH_TOKEN="eyJhbGci..."
   $env:ANTHROPIC_API_KEY="sk-ant-..."
   $env:DEFAULT_BACKEND="sider"
   $env:AUTO_FALLBACK="true"
   $env:PREFER_SIDER_FOR_CHAT="true"
   ```

   **Linux/macOS**:
   ```bash
   # 客户端认证 Token
   export AUTH_TOKEN="your-custom-auth-token"

   # 场景 1: 只用 Sider AI
   export SIDER_AUTH_TOKEN="eyJhbGci..."

   # 场景 2: 只用 Anthropic API
   export ANTHROPIC_API_KEY="sk-ant-..."

   # 场景 3: 混合使用（推荐）
   export SIDER_AUTH_TOKEN="eyJhbGci..."
   export ANTHROPIC_API_KEY="sk-ant-..."
   export DEFAULT_BACKEND="sider"
   export AUTO_FALLBACK="true"
   export PREFER_SIDER_FOR_CHAT="true"
   ```

   **或使用快速启动脚本**（Windows）:
   ```bash
   cd deno
   .\start-local.bat
   ```

3. **运行开发服务器**
   ```bash
   # 从项目根目录执行
   deno task dev

   # 或从 deno 目录执行
   cd deno
   deno run --allow-net --allow-env --allow-read --watch main.ts
   ```

4. **测试 API**
   ```bash
   # 健康检查
   curl http://localhost:8000/health

   # 消息 API
   curl -X POST http://localhost:8000/v1/messages \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer your-custom-auth-token" \
     -d '{
       "model": "claude-3.7-sonnet",
       "messages": [{"role": "user", "content": "Hello"}],
       "max_tokens": 100
     }'
   ```

## 🔧 环境变量详解

### 认证配置

| 变量名 | 说明 | 示例值 | 必需 |
|--------|------|--------|------|
| `AUTH_TOKEN` | 客户端认证 Token（自定义） | `your-custom-auth-token` | ✅ 是 |
| `SIDER_AUTH_TOKEN` | Sider AI JWT Token | `eyJhbGci...` | ⚠️ 场景 1、3 |
| `ANTHROPIC_API_KEY` | Anthropic 官方 API Key | `sk-ant-...` | ⚠️ 场景 2、3 |

### 后端配置

| 变量名 | 说明 | 可选值 | 默认值 |
|--------|------|--------|--------|
| `SIDER_API_URL` | Sider API 端点 | URL | `https://sider.ai/api/chat/v1/completions` |
| `ANTHROPIC_BASE_URL` | Anthropic API 端点 | URL | `https://api.anthropic.com` |

### 路由配置（场景 3 专用）

| 变量名 | 说明 | 可选值 | 默认值 | 推荐值 |
|--------|------|--------|--------|--------|
| `DEFAULT_BACKEND` | 默认后端 | `sider` \| `anthropic` | `sider` | `sider` |
| `AUTO_FALLBACK` | 自动降级 | `true` \| `false` | `true` | `true` |
| `PREFER_SIDER_FOR_CHAT` | 简单对话优先用 Sider | `true` \| `false` | `true` | `true` |
| `DEBUG_ROUTING` | 打印路由决策日志 | `true` \| `false` | `false` | `false` |

### 其他配置

| 变量名 | 说明 | 默认值 | 必需 |
|--------|------|--------|------|
| `PORT` | 服务器端口 | `8000` | ❌ 否 |
| `NODE_ENV` | 环境模式 | `development` | ❌ 否 |
| `LOG_LEVEL` | 日志级别 | `info` | ❌ 否 |
| `REQUEST_TIMEOUT` | 请求超时（毫秒） | `30000` | ❌ 否 |

## 📖 如何获取 Token

### Sider AI Token

1. 访问 https://sider.ai 并登录
2. 打开开发者工具（F12）→ Network 标签
3. 发送一条消息到 AI
4. 找到 `completions` 请求
5. 复制 `Authorization` header 中的 Token（以 `eyJhbGci` 开头）

**示例**：
```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyX2lkIjoyMzM4NzQ...
```

### Anthropic API Key

1. 访问 https://console.anthropic.com
2. 登录并进入 **API Keys** 页面
3. 点击 **Create Key** 创建新的 API Key
4. 复制生成的 Key（以 `sk-ant-` 开头）

**示例**：
```
sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### AUTH_TOKEN（客户端认证）

这是你自定义的认证 Token，用于保护你的 API 服务。

**建议**：
- 使用强随机字符串
- 至少 32 个字符
- 包含字母、数字、特殊字符

**生成方法**：
```bash
# Linux/macOS
openssl rand -hex 32

# Windows PowerShell
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
```

## 🎯 智能路由工作原理

当同时配置了 Sider AI 和 Anthropic API 时，系统会根据请求特征智能路由：

```
客户端请求
    ↓
路由引擎分析
    ├─ 检查是否需要工具调用
    ├─ 检查是否是 MCP 请求
    ├─ 检查是否是子代理请求
    └─ 检查 PREFER_SIDER_FOR_CHAT 设置
    ↓
    ├─→ 简单对话 → Sider AI（免费）
    ├─→ 工具调用 → Anthropic API（付费）
    ├─→ MCP 请求 → Anthropic API（付费）
    └─→ 子代理 → Anthropic API（付费）
    ↓
自动降级（如果启用）
    └─ 主后端失败 → 切换到备用后端
```

**示例：成本节省**

假设每天 100 次请求：
- 80 次简单对话 → Sider AI（免费）
- 20 次工具调用 → Anthropic API（付费）

**成本节省**：80% 的请求免费 = **节省约 80% 成本**

## 📁 目录结构

```
deno/
├── main.ts                 # Deno Deploy 入口文件
├── README.md               # 本文件
├── .env                    # 环境变量配置文件（包含详细说明）
├── start-local.bat         # Windows 快速启动脚本
└── src/
    ├── types/              # TypeScript 类型定义
    │   ├── anthropic.ts
    │   ├── sider.ts
    │   └── index.ts
    ├── middleware/         # 中间件
    │   └── auth.ts
    ├── utils/              # 工具函数
    │   ├── env.ts                      # 环境变量适配层
    │   ├── request-converter.ts        # 请求转换
    │   ├── response-converter.ts       # 响应转换
    │   ├── sider-client.ts             # Sider API 客户端
    │   ├── conversation-manager.ts     # 会话管理
    │   └── sider-session-manager.ts    # Sider 会话管理
    ├── routing/            # 路由引擎
    │   └── router-engine.ts            # 智能路由决策
    ├── adapters/           # 后端适配器
    │   └── anthropic-adapter.ts        # Anthropic API 适配器
    ├── config/             # 配置管理
    │   ├── backends.ts                 # 后端配置
    │   └── models.ts                   # 模型映射
    └── routes/             # API 路由
        ├── messages.ts
        ├── messages-hybrid.ts          # 混合路由主入口
        └── models.ts
```

## 🔍 验证部署

部署后，可以使用以下命令测试：

```bash
# 设置你的部署 URL
export DENO_URL="https://your-project.deno.dev"
export AUTH_TOKEN="your-custom-auth-token"

# 健康检查
curl $DENO_URL/health

# 测试简单对话（应该路由到 Sider AI）
curl -X POST $DENO_URL/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -d '{
    "model": "claude-3.7-sonnet",
    "messages": [
      {"role": "user", "content": "你好，请用一句话介绍你自己。"}
    ],
    "max_tokens": 100,
    "stream": false
  }'

# 测试工具调用（应该路由到 Anthropic API）
curl -X POST $DENO_URL/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -d '{
    "model": "claude-3.7-sonnet",
    "messages": [
      {"role": "user", "content": "Search for latest AI news"}
    ],
    "tools": [
      {
        "name": "web_search",
        "description": "Search the web",
        "input_schema": {"type": "object"}
      }
    ],
    "max_tokens": 1000
  }'
```

## 📊 与 Bun/Railway 版本对比

| 特性 | Bun/Railway | Deno Deploy | 说明 |
|------|------------|-------------|------|
| **运行时** | Bun | Deno | 都是高性能运行时 |
| **冷启动** | ~1-2s | ~50-200ms | Deno 更快 ⭐ |
| **全球分发** | 单区域 | 35+ 边缘节点 | Deno 全球覆盖 ⭐ |
| **免费额度** | $5/月 | 100万请求/月 | Deno 更高 ⭐ |
| **部署方式** | GitHub 集成 | GitHub 集成 / CLI | 都支持 |
| **API 兼容性** | 100% | 100% | 完全相同 |
| **智能路由** | ✅ | ✅ | 功能一致 |
| **会话管理** | 内存存储 | 内存存储 | 功能一致 |

## 🆚 主要差异

### 代码层面

| 特性 | Bun 版本 | Deno 版本 |
|------|---------|----------|
| **环境变量** | `process.env.VAR` | `Deno.env.get('VAR')` |
| **导入扩展名** | 可选 `.ts` | 必须 `.ts` |
| **npm 包** | 直接导入 | `npm:` 前缀 |
| **日志库** | consola | console |
| **导出方式** | `export default app` | `export default { fetch: app.fetch }` |

### 运行时层面

- **Deno Deploy** 在全球 35+ 个边缘节点运行，距离用户更近
- **冷启动时间** 显著减少（50-200ms vs 1-2s）
- **自动扩展**，无需手动配置

## 📝 API 端点

所有 API 端点与原版完全相同：

- `GET /health` - 健康检查
- `GET /` - API 信息
- `POST /v1/messages` - 创建消息（核心端点，支持智能路由）
- `POST /v1/messages/count_tokens` - Token 计数
- `GET /v1/messages/conversations` - 查看会话状态
- `POST /v1/messages/conversations/cleanup` - 清理过期会话
- `GET /v1/messages/sider-sessions` - 查看 Sider 会话
- `POST /v1/messages/sider-sessions/cleanup` - 清理 Sider 会话
- `GET /v1/models` - 列出支持的模型

## 🐛 故障排除

### 1. 认证失败（401 Unauthorized）

**问题**：请求返回 401 错误

**原因**：
- `AUTH_TOKEN` 未配置
- 客户端使用的 Token 与 `AUTH_TOKEN` 不匹配

**解决**：
```bash
# 检查环境变量
echo $AUTH_TOKEN  # Linux/macOS
echo $env:AUTH_TOKEN  # Windows PowerShell

# 确保客户端请求使用相同的 Token
curl -H "Authorization: Bearer <AUTH_TOKEN>" ...
```

### 2. Sider AI 返回 403 Forbidden

**问题**：使用 Sider AI 时返回 403 错误

**原因**：
- `SIDER_AUTH_TOKEN` 未配置或已过期
- Token 格式不正确

**解决**：
1. 重新从 sider.ai 获取 Token（见上方"如何获取 Token"）
2. 确保 Token 以 `eyJhbGci` 开头
3. Token 有效期通常为 30 天，过期需重新获取

### 3. Anthropic API 返回 401

**问题**：使用 Anthropic API 时返回 401 错误

**原因**：
- `ANTHROPIC_API_KEY` 未配置或无效
- API Key 格式不正确

**解决**：
1. 检查 API Key 是否以 `sk-ant-` 开头
2. 在 https://console.anthropic.com 确认 Key 状态
3. 检查账户余额是否充足

### 4. 路由未按预期工作

**问题**：简单对话被路由到 Anthropic API

**原因**：
- `PREFER_SIDER_FOR_CHAT` 未设置为 `true`
- `DEFAULT_BACKEND` 设置为 `anthropic`

**解决**：
```bash
# 启用简单对话优先使用 Sider
export PREFER_SIDER_FOR_CHAT=true
export DEFAULT_BACKEND=sider

# 启用调试日志查看路由决策
export DEBUG_ROUTING=true
```

### 5. 导入错误

**问题**：Deno 报告找不到模块

**原因**：导入路径缺少 `.ts` 扩展名

**解决**：
```typescript
// ✅ 正确
import { foo } from './utils/bar.ts'

// ❌ 错误
import { foo } from './utils/bar'
```

### 6. 环境变量未设置

**问题**：Deno Deploy 运行时无法读取环境变量

**解决**：
1. 登录 Deno Deploy Dashboard
2. 进入项目设置 → Environment Variables
3. 添加所有必需的环境变量
4. 重新部署项目

### 7. 权限错误

**问题**：本地运行时报告权限错误

**解决**：
```bash
# 确保运行时有足够的权限
deno run --allow-net --allow-env --allow-read deno/main.ts
```

### 8. npm 包导入失败

**问题**：无法导入 npm 包

**解决**：
确保所有 npm 包都在项目根目录的 `deno.json` 的 `imports` 中声明：

```json
{
  "imports": {
    "hono": "npm:hono@4.9.0",
    "consola": "npm:consola@3.2.3"
  }
}
```

## 🔗 相关链接

- [Deno Deploy 文档](https://deno.com/deploy/docs)
- [Hono 框架文档](https://hono.dev/)
- [Deno 标准库](https://deno.land/std)
- [deployctl CLI](https://deno.com/deploy/docs/deployctl)
- [Anthropic API 文档](https://docs.anthropic.com/)

## 💡 最佳实践

### 生产环境配置建议

1. **使用混合模式**（场景 3）
   - 同时配置 Sider AI 和 Anthropic API
   - 设置 `PREFER_SIDER_FOR_CHAT=true`
   - 启用 `AUTO_FALLBACK=true` 确保高可用

2. **安全性**
   - 使用强随机 `AUTH_TOKEN`（至少 32 字符）
   - 定期轮换 Sider Token（建议每 15-20 天）
   - 不要在代码中硬编码 Token

3. **成本优化**
   - 优先使用 Sider AI 处理简单对话
   - 仅在需要工具调用时使用 Anthropic API
   - 监控 API 使用量和成本

4. **监控和日志**
   - 生产环境设置 `LOG_LEVEL=info`
   - 调试时设置 `LOG_LEVEL=debug`
   - 启用 `DEBUG_ROUTING=true` 了解路由决策

5. **性能优化**
   - 利用 Deno Deploy 的全球边缘网络
   - 使用会话管理减少重复请求
   - 设置合理的 `REQUEST_TIMEOUT`

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📄 许可证

与主项目相同的许可证。

---

**部署状态**: ✅ 代码已就绪，可立即部署

**推荐场景**:
- 💰 追求成本优化 → 混合模式（场景 3）
- 🌍 追求全球低延迟 → Deno Deploy
- 🚀 追求快速启动 → Deno Deploy
- 🆓 追求免费使用 → 场景 1（Sider AI）
- ✅ 追求完整功能 → 场景 2 或 3（包含 Anthropic API）
