# Sider2Claude - Deno Deploy 版本

这是 Sider2Claude 的 Deno 兼容版本，可以部署到 Deno Deploy 平台。

## ✨ 特性

- ✅ **零配置部署**：直接部署到 Deno Deploy
- ✅ **全球边缘网络**：35+ 个边缘节点，超低延迟
- ✅ **快速冷启动**：~50-200ms 冷启动时间
- ✅ **高性能**：基于 Deno 运行时和 Hono 框架
- ✅ **完全兼容**：100% 兼容原版 API

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
   - **环境变量**：
     ```env
     SIDER_AUTH_TOKEN=<你的Sider Token>
     SIDER_API_URL=https://sider.ai/api/chat/v1/completions
     PORT=8000
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

2. **设置环境变量**
   ```bash
   # Linux/macOS
   export SIDER_AUTH_TOKEN="your-token-here"

   # Windows PowerShell
   $env:SIDER_AUTH_TOKEN="your-token-here"
   ```

3. **运行开发服务器**
   ```bash
   # 从项目根目录执行
   deno task dev
   ```

4. **测试 API**
   ```bash
   # 健康检查
   curl http://localhost:8000/health

   # 消息 API
   curl -X POST http://localhost:8000/v1/messages \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer your-token" \
     -d '{
       "model": "claude-3.7-sonnet",
       "messages": [{"role": "user", "content": "Hello"}],
       "max_tokens": 100
     }'
   ```

## 📁 目录结构

```
deno/
├── main.ts                 # Deno Deploy 入口文件
├── README.md               # 本文件
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
    └── routes/             # API 路由
        └── messages.ts
```

## 🔧 配置说明

### 环境变量

| 变量名 | 说明 | 默认值 | 必需 |
|--------|------|--------|------|
| `SIDER_AUTH_TOKEN` | Sider API 认证 Token | - | ✅ 是 |
| `SIDER_API_URL` | Sider API 端点 | `https://sider.ai/api/chat/v1/completions` | ❌ 否 |
| `PORT` | 服务器端口 | `8000` | ❌ 否 |
| `LOG_LEVEL` | 日志级别 | `info` | ❌ 否 |
| `REQUEST_TIMEOUT` | 请求超时（毫秒） | `30000` | ❌ 否 |

### deno.json 配置

```json
{
  "tasks": {
    "dev": "deno run --allow-net --allow-env --allow-read --watch deno/main.ts",
    "start": "deno run --allow-net --allow-env --allow-read deno/main.ts"
  },
  "imports": {
    "hono": "npm:hono@4.9.0",
    "consola": "npm:consola@3.2.3",
    "gpt-tokenizer": "npm:gpt-tokenizer@2.8.1",
    "tiny-invariant": "npm:tiny-invariant@1.3.3",
    "fetch-event-stream": "npm:fetch-event-stream@1.0.0"
  }
}
```

## 🔍 验证部署

部署后，可以使用以下命令测试：

```bash
# 设置你的部署 URL
export DENO_URL="https://your-project.deno.dev"

# 健康检查
curl $DENO_URL/health

# 测试消息 API
curl -X POST $DENO_URL/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-sider-token" \
  -d '{
    "model": "claude-3.7-sonnet",
    "messages": [
      {"role": "user", "content": "你好，请用一句话介绍你自己。"}
    ],
    "max_tokens": 100,
    "stream": false
  }'
```

## 📊 与 Bun/Railway 版本对比

| 特性 | Bun/Railway | Deno Deploy | 说明 |
|------|------------|-------------|------|
| **运行时** | Bun | Deno | 都是高性能运行时 |
| **冷启动** | ~1-2s | ~50-200ms | Deno 更快 |
| **全球分发** | 单区域 | 35+ 边缘节点 | Deno 全球覆盖 |
| **免费额度** | $5/月 | 100万请求/月 | Deno 更高 |
| **部署方式** | GitHub 集成 | GitHub 集成 / CLI | 都支持 |
| **API 兼容性** | 100% | 100% | 完全相同 |
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

## 🔗 相关链接

- [Deno Deploy 文档](https://deno.com/deploy/docs)
- [Hono 框架文档](https://hono.dev/)
- [Deno 标准库](https://deno.land/std)
- [deployctl CLI](https://deno.com/deploy/docs/deployctl)

## 📝 API 端点

所有 API 端点与原版完全相同：

- `GET /health` - 健康检查
- `GET /` - API 信息
- `POST /v1/messages` - 创建消息（核心端点）
- `POST /v1/messages/count_tokens` - Token 计数
- `GET /v1/messages/conversations` - 查看会话状态
- `POST /v1/messages/conversations/cleanup` - 清理过期会话
- `GET /v1/messages/sider-sessions` - 查看 Sider 会话
- `POST /v1/messages/sider-sessions/cleanup` - 清理 Sider 会话

## 🐛 故障排除

### 导入错误

确保所有导入都有 `.ts` 后缀：

```typescript
// ✅ 正确
import { foo } from './utils/bar.ts'

// ❌ 错误
import { foo } from './utils/bar'
```

### 环境变量未设置

确保在 Deno Deploy Dashboard 配置了 `SIDER_AUTH_TOKEN`。

### 权限错误

确保运行时有足够的权限：

```bash
deno run --allow-net --allow-env --allow-read deno/main.ts
```

### npm 包导入失败

确保所有 npm 包都在 `deno.json` 的 `imports` 中声明。

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📄 许可证

与主项目相同的许可证。

---

**部署状态**: ✅ 代码已就绪，可立即部署

**推荐**: 适合追求全球低延迟和高免费额度的用户
