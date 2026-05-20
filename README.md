# Sider2Claude

Sider2Claude 是一个面向 Claude Code 的 Anthropic API 兼容代理。当前落地方案是：

- 主模型普通对话由 Sider 提供，模型仍以 Claude/Anthropic 名称对外暴露。
- Claude Code 工具、MCP 工具、自定义 `tool_use` 等 Sider 无法稳定提供的能力，由 DeepSeek Anthropic 兼容端补齐。
- DeepSeek 上游模型固定默认为 `deepseek-v4-flash`，对外响应仍保留客户端请求的 Claude 模型名。
- DeepSeek 返回的 `thinking` / `redacted_thinking` / `tool_use` 内容块会按 Anthropic Messages 结构透传，避免能力兜底路径丢失推理或工具调用信息。

## 当前能力结论

最新 Sider probe 结果：

- Sider 能提供普通文本对话事件：`text`。
- Sider think 模型能提供推理事件：`reasoning_content`。
- 典型模型 `claude-sonnet-4.6` 对 Anthropic `tool_use` 探测返回 `NO_TOOL_USE`，未出现 `tool_use` 内容块。
- 因此工具能力统一路由到 DeepSeek 是当前最稳妥的设计。

相关脚本：

```bash
deno task probe:sider
```

可选筛选：

```bash
# 只探测一个模型的普通对话
$env:SIDER_PROBE_MODEL="claude-sonnet-4.6"
$env:SIDER_PROBE_CASES="simple_chat"
deno task probe:sider
```

## 架构

```text
Claude Code / Anthropic 客户端
  |
  | Anthropic Messages API
  v
Sider2Claude
  |
  |-- 普通对话 -----------------> Sider
  |
  |-- Claude Code 工具/MCP/tool_use -> DeepSeek /anthropic
```

核心模块：

- `src/config/backends.ts` / `deno/src/config/backends.ts`：统一后端配置。
- `src/config/models.ts` / `deno/src/config/models.ts`：18 个 Claude 模型/别名到 Sider 模型的映射。
- `src/routing/router-engine.ts` / `deno/src/routing/router-engine.ts`：路由决策。
- `src/adapters/anthropic-adapter.ts` / `deno/src/adapters/anthropic-adapter.ts`：DeepSeek Anthropic 兼容适配器。
- `src/utils/env.ts` / `deno/src/utils/env.ts`：运行时环境变量 + 根目录 `.env` 统一读取。

## 环境配置

根目录 `.env` 可直接作为本地开发配置源。运行时环境变量优先级高于 `.env`。

```env
PORT=4141
AUTH_TOKEN=your-client-token

SIDER_API_URL=https://sider.ai/api/chat/v1/completions
SIDER_AUTH_TOKEN=your-sider-jwt

DEEPSEEK_BASE_URL=https://api.deepseek.com/anthropic
DEEPSEEK_API_KEY=your-deepseek-key
DEEPSEEK_MODEL=deepseek-v4-flash

DEFAULT_BACKEND=sider
AUTO_FALLBACK=true
PREFER_SIDER_FOR_CHAT=true
DEBUG_ROUTING=false
REQUEST_TIMEOUT=30000
```

兼容旧变量：

- `ANTHROPIC_BASE_URL` 仅在指向 `deepseek.com` 时作为 `DEEPSEEK_BASE_URL` 的旧别名。
- `ANTHROPIC_API_KEY` 仅在没有非 DeepSeek 的 `ANTHROPIC_BASE_URL` 干扰时作为 `DEEPSEEK_API_KEY` 的旧别名。
- `DEFAULT_BACKEND=anthropic` 会被兼容映射为 `deepseek`。

推荐始终使用 `DEEPSEEK_*` 配置工具能力兜底，避免和 Claude Code 客户端自己的 `ANTHROPIC_BASE_URL` 混淆。

不要把真实 token 写入源码或文档。

## 快速启动

Bun 版本：

```bash
npm install
bun run dev
```

Deno 版本：

```bash
deno task dev
```

健康检查：

```bash
curl http://localhost:4141/health
```

## Claude Code 配置

本地 Bun 服务：

```bash
export ANTHROPIC_BASE_URL=http://localhost:4141
export ANTHROPIC_AUTH_TOKEN=your-client-token
export ANTHROPIC_MODEL=claude-sonnet-4.6
export ANTHROPIC_SMALL_FAST_MODEL=claude-haiku-4.5
```

Windows PowerShell：

```powershell
$env:ANTHROPIC_BASE_URL="http://localhost:4141"
$env:ANTHROPIC_AUTH_TOKEN="your-client-token"
$env:ANTHROPIC_MODEL="claude-sonnet-4.6"
$env:ANTHROPIC_SMALL_FAST_MODEL="claude-haiku-4.5"
```

`ANTHROPIC_AUTH_TOKEN` 应填写本服务的 `AUTH_TOKEN`，不是 Sider token，也不是 DeepSeek key。

## 支持模型

当前对外暴露 18 个模型/别名，统一映射到 Sider：

- `claude-3.7-sonnet`
- `claude-3-7-sonnet`
- `claude-4-sonnet`
- `claude-4-sonnet-think`
- `claude-4.1-opus`
- `claude-4.1-opus-think`
- `claude-opus-4.5`
- `claude-opus-4.5-think`
- `claude-opus-4.6`
- `claude-opus-4.6-think`
- `claude-4.5-sonnet`
- `claude-4.5-sonnet-think`
- `claude-sonnet-4.6`
- `claude-sonnet-4.6-think`
- `claude-haiku-4.5`
- `claude-haiku-4.5-think`
- `claude-3-sonnet`
- `claude-sonnet`

注意：Sider 账号配额可能让部分 Opus 模型临时返回用量限制，这不影响路由策略本身。

## 测试

确定性回归测试：

```bash
npm run test:regression
```

等价拆分：

```bash
deno task test
deno task check
deno check deno/tools/probe-sider-capabilities.ts
npm run typecheck
```

服务级黑盒集成测试需要先启动服务：

```bash
# 终端 1
bun run dev

# 终端 2
npm run test:integration
```

切换测试环境：

```bash
$env:TEST_ENV="deno-local"
$env:TEST_API_BASE_URL="http://localhost:8000"
npm run test:integration
```

更多说明见 `test/TEST-README.md`。

当前真实外部集成结论：

- `01-health-check`、`02-basic-messages`、`04-streaming`、`05-token-counting` 已在本地 Bun 服务 + 真实 Sider/DeepSeek 配置下通过。
- `03-session-persistence` 中的会话创建与会话统计接口通过；多轮语义断言依赖 Sider 上游是否在第二轮按测试提示复述上下文，可能受模型行为与 Sider 会话语义影响而波动。

## API

主要端点：

- `GET /health`
- `GET /v1/models`
- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- `GET /v1/messages/backends/status`
- `GET /v1/messages/conversations`
- `GET /v1/messages/sider-sessions`
- `POST /v1/complete`（legacy）

普通消息示例：

```bash
curl -X POST http://localhost:4141/v1/messages \
  -H "Authorization: Bearer your-client-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4.6",
    "messages": [{"role": "user", "content": "你好"}],
    "max_tokens": 200
  }'
```

工具请求会被路由到 DeepSeek：

```bash
curl -X POST http://localhost:4141/v1/messages \
  -H "Authorization: Bearer your-client-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4.6",
    "messages": [{"role": "user", "content": "运行 pwd"}],
    "tools": [{
      "name": "Bash",
      "description": "Run shell command",
      "input_schema": {
        "type": "object",
        "properties": {"command": {"type": "string"}},
        "required": ["command"]
      }
    }],
    "max_tokens": 200
  }'
```

## 维护原则

- 配置统一走 `getEnv()`，避免各模块分别读取 `.env`。
- 新增模型必须同步 Deno 与 Node/Bun 两套 `models.ts`，并补测试。
- 涉及工具能力的改动必须覆盖 DeepSeek adapter 与路由测试。
- DeepSeek adapter 必须兼容 `text`、`thinking`、`redacted_thinking`、`tool_use` 内容块。
- 线上 probe 结果可作为报告证据，但真实 token 和临时 JSON 不应提交。
