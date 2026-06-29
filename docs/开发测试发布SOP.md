# Sider2Claude 开发、测试、发布标准操作流程 (SOP)

基于 2026-06-29 本地开发验证，作为后续迭代的标准工作流。

参考上游仓库 `goldenhawksu/sider2api` 的 SOP 模式适配本项目 TypeScript/Bun/Deno 技术栈。

---

## 角色与核心原则

- **本地优先**：所有开发、单元测试、集成回归必须本地通过后才能推送。
- **推送需授权**：推送到 main 分支或远端必须经用户明确同意，推送即触发远端部署验证。
- **诚实报告**：测试失败必须贴实际错误输出；跳过的步骤必须注明；禁止伪造通过结果。
- **不破坏 API**：任何修改不能破坏 Anthropic Messages API 响应结构。

---

## 1. 一次性环境搭建

### 运行环境

| 运行时 | 安装方式 | 验证命令 |
|--------|---------|---------|
| **Bun** | `npm install -g bun` 或官网安装脚本 | `bun --version` |
| **Deno** | `irm https://deno.land/install.ps1 \| iex` (Windows PowerShell) | `deno --version` |
| **Node.js** | 通过 nvm / fnm 或官网安装 | `node --version` |

仓库根目录安装依赖：

```bash
bun install
```

### 凭证配置 (`.env`)

`.env` 已 gitignore，绝不能提交。关键变量：

```env
AUTH_TOKEN=your-client-token          # 客户端认证 token
SIDER_AUTH_TOKEN=your-sider-jwt       # Sider 上游 JWT
SIDER_API_URL=https://sider.ai/api/chat/v1/completions

DEEPSEEK_BASE_URL=https://api.deepseek.com/anthropic
DEEPSEEK_API_KEY=your-deepseek-key
DEEPSEEK_MODEL=deepseek-v4-flash

DEFAULT_BACKEND=sider
AUTO_FALLBACK=true
PREFER_SIDER_FOR_CHAT=true
DEBUG_ROUTING=false
```

本地开发默认端口：
- Bun 服务：`http://localhost:4141`
- Deno 服务：`http://localhost:8000`（可用 `PORT` 环境变量覆盖）

### 验证环境

```bash
# 静态检查
deno task check          # Deno 主入口类型检查
npm run typecheck        # Node/Bun TypeScript 检查

# 确定性回归（无需启动服务、不访问外部）
npm run test:regression

# 启动本地服务
bun run dev              # Bun 服务，端口 4141
# 或
deno task dev            # Deno 服务，端口 8000
```

---

## 2. 敏捷迭代循环

完整流程：*用户需求 → 本地开发 → 静态检查 → 本地启动 → 分层测试 → 报告 → (用户审批) → 推送 → 远端部署 → 远端验证*

### 第一步：本地开发

根据需求编辑相关源文件。核心文件：

| 文件 | 用途 |
|------|------|
| `src/routes/messages-hybrid.ts` | Bun 混合路由入口 |
| `deno/src/routes/messages-hybrid.ts` | Deno 混合路由入口 |
| `src/routing/router-engine.ts` | 路由引擎 |
| `deno/src/routing/router-engine.ts` | Deno 路由引擎 |
| `src/adapters/anthropic-adapter.ts` | Anthropic 格式适配器 |
| `deno/src/adapters/anthropic-adapter.ts` | Deno Anthropic 适配器 |
| `src/config/models.ts` | 模型清单 (Bun) |
| `deno/src/config/models.ts` | 模型清单 (Deno) |

修改模型清单时必须同步两份文件并更新 `deno/test/hybrid-routing.test.ts`。

### 第二步：静态类型检查（提交前必须）

```bash
# 全部确定性回归（推荐）
npm run test:regression

# 或分步执行
deno task test           # Deno 单元测试
deno task check          # Deno 类型检查
deno check deno/tools/probe-sider-capabilities.ts  # 探针脚本检查
npm run typecheck        # Bun/Node TypeScript 检查
```

期望：所有命令零错误退出。

### 第三步：启动本地服务器

**先杀掉旧进程**——僵尸进程占用端口但 token 未加载会导致所有请求返回 "Invalid Token"。

```bash
# Windows PowerShell - 杀掉占用端口的进程
Get-Process -Id (Get-NetTCPConnection -LocalPort 4141 -ErrorAction SilentlyContinue).OwningProcess -ErrorAction SilentlyContinue | Stop-Process -Force

# 启动 Bun 服务
bun run dev
```

确认服务启动：
```bash
curl http://localhost:4141/health
```

### 第四步：分层测试

#### A. 冒烟测试（零上游成本）

验证服务基本可用性，不消耗上游配额：

```bash
bun run test/smoke-test.ts
```

覆盖：健康检查、CORS、模型列表格式、认证 401、无效请求 400。

#### B. 服务级集成测试（消耗上游配额）

确保本地服务正在运行，然后：

```bash
# 默认测试 Bun 本地服务
npm run test:integration

# 或指定 Deno 本地服务
$env:TEST_ENV="deno-local"
npm run test:integration
```

覆盖：模型列表、基础消息、多轮会话、流式 SSE、Token 计数。

#### C. Sider 上游能力探针（按需）

仅在需要确认上游能力变化时运行：

```bash
deno task probe:sider
```

常用筛选：
```bash
$env:SIDER_PROBE_MODEL="claude-sonnet-4.6"
$env:SIDER_PROBE_CASES="simple_chat,anthropic_tool_shape"
deno task probe:sider
```

#### D. 生产环境验证（推送后）

见下方「第七步」。

### 第五步：生成报告

测试完成后将结果写入 `test/reports/`：

```bash
# 集成测试报告自动生成在 test/reports/integration-YYYYMMDD-HHMMSS.md
npm run test:integration
```

手动补充本地测试报告：

```bash
# 报告模板见 test/reports/本地测试报告_模板.md
```

报告内容：环境信息、静态检查结果、分层测试矩阵、失败排查、结论/待办。

### 第六步：推送（需要用户明确同意）

```bash
# 推送前最终检查
git status                     # 确认无 .env
git diff --stat origin/main    # 审查变更范围
npm run test:regression        # 最后一次确定性回归

# 推送（需用户批准）
git push origin main
```

> ⚠️ 推送 main 分支会触发 CI 流水线（如有配置）。

### 第七步：远端部署后验证

等待部署完成（通常 30 秒 ~ 2 分钟，取决于部署平台），然后运行生产验证：

```bash
# 设置生产环境
$env:TEST_ENV="deno-deploy"
$env:TEST_API_BASE_URL="https://your-deployed-url"

# 运行冒烟测试
bun run test/smoke-test.ts

# 运行完整集成测试
npm run test:integration
```

---

## 3. 测试后清理

```bash
# 杀掉本地服务进程
# Windows: 任务管理器或 Get-Process | Stop-Process

# 确认状态
git status                     # 无意外修改
git status --porcelain | findstr ".env"  # 确认 .env 未暂存

# 清理临时文件
Remove-Item server.log -ErrorAction SilentlyContinue
```

---

## 4. 快速排障指南

| 症状 | 根因 | 解决方案 |
|------|------|---------|
| 所有请求返回 401 | 僵尸进程占用端口或 token 无效 | 杀掉旧进程，重启服务 |
| `ECONNREFUSED` | 服务未启动 | 启动 `bun run dev` |
| DeepSeek 工具请求 400 | thinking passback 校验失败 | 确认历史 tool_use 已转录；运行 `deno test --allow-env deno/test/deepseek-adapter.test.ts` |
| Sider 对话返回空文本 | Sider 配额不足 | 检查 Sider 账户状态 |
| 模型返回 "not supported" | 模型映射不存在 | 检查 `src/config/models.ts` 和 `deno/src/config/models.ts` |
| Deno check 报告 unknown type | 非阻塞警告 | 使用 `error instanceof Error ? error.message : String(error)` 模式 |
| 中文字符输出乱码 | 控制台编码问题 | 设置 `PYTHONIOENCODING=utf-8`（如用 Python 辅助脚本） |

---

## 5. 每次回归必检项 (Invariants)

- [ ] `GET /v1/models` 返回模型列表，`data` 数组非空，每个模型含 `id`、`object: "model"`
- [ ] `POST /v1/messages` 非流式返回 `{id, model, content, usage}` 符合 Anthropic Messages 结构
- [ ] `POST /v1/messages` 流式 (`stream: true`) 返回 `text/event-stream`，以 `data: [DONE]` 结束
- [ ] `POST /v1/messages/count_tokens` 返回 `{input_tokens: number}`
- [ ] 缺少 `Authorization` header 时返回 401
- [ ] 无效请求（缺少 `model`）返回 400
- [ ] 多轮对话通过 `cid` query 参数或 session header 保持上下文
- [ ] Claude Code 工具请求（含 `Bash`、`Read`、`Write` 等）正确路由到 DeepSeek
- [ ] DeepSeek 返回的 `thinking` / `tool_use` 内容块按 Anthropic 结构透传
- [ ] 上游错误返回结构化错误（HTTP 4xx/5xx），不崩溃

---

## 附录：环境矩阵速查

| 环境 | 运行时 | 地址 | 用途 |
|------|--------|------|------|
| 本地开发/测试 (Bun) | `bun run dev` | `http://localhost:4141` | 功能开发、集成测试 |
| 本地开发/测试 (Deno) | `deno task dev` | `http://localhost:8000` | Deno 运行时验证 |
| 远端部署 | 部署平台 | 按 `TEST_API_BASE_URL` 配置 | 功能/性能验证 |

两个本地环境均可指向同样的上游 Sider + DeepSeek，调用消耗真实额度。
