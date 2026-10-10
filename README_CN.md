# Sider2Claude

Sider2Claude 是一个面向 Claude Code 的 Anthropic API 兼容代理。当前落地方案是：

- 主模型普通对话由 Sider 提供，模型仍以 Claude/Anthropic 名称对外暴露。
- 非流式 Controller 可用 Sider 5.5 文本工具契约；流式 Claude Code 工具请求在 SSE 开始前由
  混合路由交给 Anthropic 兼容能力端，避免不可回退的半截响应。
- DeepSeek 上游模型固定默认为 `deepseek-v4-flash`，对外响应仍保留客户端请求的 Claude 模型名。
- DeepSeek 返回的 `thinking` / `redacted_thinking` / `tool_use` 内容块会按 Anthropic Messages
  结构透传。
- 转发到 DeepSeek 前会删除顶层 `thinking` 参数，并把历史 `thinking` / `redacted_thinking` /
  `tool_use` / `tool_result` 内容块转录为普通文本，避免 DeepSeek 在工具续轮中要求完整 thinking
  passback 而返回 400。

## 当前能力结论

最新 Sider probe 结果：

- Sider 能提供普通文本对话事件：`text`。
- Sider think 模型能提供推理事件：`reasoning_content`。
- `claude-opus-5.5`、`claude-sonnet-5.5`、`claude-haiku-5.5` 均通过严格文本工具契约与
  tool_result 续轮探测，并可完整输出约 9K 文本。
- Sider 直接输入约 7.7K 中文会返回 603；Controller 使用 6K 安全分段。流式工具请求默认在
  SSE 开始前走混合路由，非流式 Controller 工具流可用开关单独验证。

相关脚本：

```bash
deno task probe:sider
```

可选筛选：

```bash
# 只探测一个模型的普通对话
$env:SIDER_PROBE_MODEL="claude-sonnet-5.5"
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
  |-- 普通对话 / 非流式 Controller -> Sider 5.5
  |
  |-- 流式工具/MCP/tool_use --------> Anthropic 兼容能力端
```

核心模块：

- `src/config/backends.ts` / `deno/src/config/backends.ts`：统一后端配置。
- `src/config/models.ts` / `deno/src/config/models.ts`：106 个上游模型及 Claude 5.5 默认映射。
- `src/routing/router-engine.ts` / `deno/src/routing/router-engine.ts`：路由决策。
- `src/adapters/anthropic-adapter.ts` / `deno/src/adapters/anthropic-adapter.ts`：DeepSeek Anthropic
  兼容适配器。
- `src/utils/env.ts` / `deno/src/utils/env.ts`：运行时环境变量 + 根目录 `.env` 统一读取。

## DeepSeek 工具续轮兼容

DeepSeek 的 Anthropic 兼容端在 thinking 模式下会校验历史 `content[].thinking` 是否完整回传。Claude
Code 的工具循环可能会压缩或重建历史推理块，导致带 `tool_use` / `tool_result` 的续轮请求被上游拒绝。

本服务的处理策略是：

- 新工具请求仍以 Anthropic `tools` 结构发给 DeepSeek，让 DeepSeek 原生产生 `tool_use`。
- 历史工具交互转发前转录为文本，例如 `[tool_use:Bash] ...` 和
  `[tool_result] ...`，保留上下文但不再触发 thinking passback 校验。
- DeepSeek 响应中的 `thinking`、`redacted_thinking` 和 `tool_use` 仍保持结构化透传给 Claude Code。
- `deno/test/deepseek-adapter.test.ts` 覆盖了该行为，提交前运行 `npm run test:regression`。

## 环境配置

根目录 `.env` 可直接作为本地开发配置源。运行时环境变量优先级高于 `.env`。

```env
PORT=4141
AUTH_TOKEN=your-client-token

SIDER_API_URL=https://sider.ai/api/chat/v1/completions
SIDER_AUTH_TOKEN=your-sider-jwt
SIDER_CONTROLLER=true
SIDER_CONTROLLER_STREAMING=false

DEEPSEEK_BASE_URL=https://api.deepseek.com/anthropic
DEEPSEEK_API_KEY=your-deepseek-key
DEEPSEEK_MODEL=deepseek-v4-flash

DEFAULT_BACKEND=sider
AUTO_FALLBACK=true
PREFER_SIDER_FOR_CHAT=true
DEBUG_ROUTING=false
REQUEST_TIMEOUT=30000
```

Controller 默认处理非流式长上下文；流式请求由混合路由直接选择可用后端，避免 SSE
开始后无法回退。只有在验证 Sider 文本工具契约时才设置 `SIDER_CONTROLLER_STREAMING=true`。

兼容旧变量：

- `DEFAULT_BACKEND=anthropic` 会被兼容映射为 `deepseek`。

工具能力兜底上游统一走 `DEEPSEEK_*` 一套配置，**没有 `ANTHROPIC_BASE_URL` /
`ANTHROPIC_API_KEY` 这两个环境变量**。`DEEPSEEK_BASE_URL` 可指向任意 Anthropic 兼容端：
要用 Z.AI 的 GLM-5.3，只需把 `DEEPSEEK_BASE_URL` 改成 Z.AI 的 Anthropic 兼容入口、
`DEEPSEEK_API_KEY` 改成 Z.AI 的 key、`DEEPSEEK_MODEL` 改成 GLM-5.3 的模型名，其余不用动。

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
export ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-5.5
export ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-5.5
export ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-haiku-5.5
```

Windows PowerShell：

```powershell
$env:ANTHROPIC_BASE_URL="http://localhost:4141"
$env:ANTHROPIC_AUTH_TOKEN="your-client-token"
$env:ANTHROPIC_DEFAULT_OPUS_MODEL="claude-opus-5.5"
$env:ANTHROPIC_DEFAULT_SONNET_MODEL="claude-sonnet-5.5"
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL="claude-haiku-5.5"
```

`ANTHROPIC_AUTH_TOKEN` 应填写本服务的 `AUTH_TOKEN`，不是 Sider token，也不是 DeepSeek key。

## 支持模型

当前对外暴露 106 个 Sider 上游模型；Claude Code 默认使用以下三款：

- `claude-opus-5.5`
- `claude-sonnet-5.5`
- `claude-haiku-5.5`

以下旧 Claude 名称仍保留兼容：

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

- `01-health-check`、`02-basic-messages`、`04-streaming`、`05-token-counting` 已在本地 Bun 服务 +
  真实 Sider/DeepSeek 配置下通过。
- `03-session-persistence` 中的会话创建与会话统计接口通过；多轮语义断言依赖 Sider
  上游是否在第二轮按测试提示复述上下文，可能受模型行为与 Sider 会话语义影响而波动。

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
    "model": "claude-sonnet-5.5",
    "messages": [{"role": "user", "content": "你好"}],
    "max_tokens": 200
  }'
```

以下流式工具请求默认由混合路由选择 Anthropic 兼容能力端；设置
`SIDER_CONTROLLER_STREAMING=true` 可实验性地改由 Sider Controller 处理：

```bash
curl -X POST http://localhost:4141/v1/messages \
  -H "Authorization: Bearer your-client-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-5.5",
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
- DeepSeek adapter 必须兼容响应侧 `text`、`thinking`、`redacted_thinking`、`tool_use`
  内容块；请求侧历史工具块必须转录为文本以规避 thinking passback 400。
- 线上 probe 结果可作为报告证据，但真实 token 和临时 JSON 不应提交。
