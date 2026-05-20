# CLAUDE.md

本文件给 Claude Code / Codex 在本仓库中工作时使用。

## 项目定位

Sider2Claude 是 Anthropic Messages API 兼容代理，目标是让 Claude Code 能通过本服务获得完整的 Anthropic 能力外观。

当前落地方案：

1. 普通 Claude 对话由 Sider 提供。
2. Claude Code 工具、MCP 工具、自定义 `tool_use` 等 Sider 不支持或不稳定支持的能力由 DeepSeek Anthropic 兼容端补齐。
3. DeepSeek 默认上游模型为 `deepseek-v4-flash`。
4. 对外始终保留客户端请求中的 Claude 模型名。
5. DeepSeek 返回的 `thinking`、`redacted_thinking`、`tool_use` 内容块必须按 Anthropic Messages 结构透传。
6. 发往 DeepSeek 的历史工具轮必须先转录为文本，避免上游在 thinking 模式下要求完整 `content[].thinking` passback。

## 开发命令

```bash
# Bun/Node 侧
bun run dev
npm run typecheck
npm run test:integration
npm run test:regression

# Deno 侧
deno task dev
deno task test
deno task check
deno task regression
deno task probe:sider
```

`npm run test:regression` 是提交前必须跑的确定性回归入口。

## 配置

统一配置读取由 `src/utils/env.ts` 和 `deno/src/utils/env.ts` 提供：

1. 运行时环境变量优先。
2. 根目录 `.env` 兜底。
3. 调用方默认值最后。

关键变量：

```env
AUTH_TOKEN=your-client-token
SIDER_AUTH_TOKEN=your-sider-jwt
SIDER_API_URL=https://sider.ai/api/chat/v1/completions

DEEPSEEK_BASE_URL=https://api.deepseek.com/anthropic
DEEPSEEK_API_KEY=your-deepseek-key
DEEPSEEK_MODEL=deepseek-v4-flash

DEFAULT_BACKEND=sider
AUTO_FALLBACK=true
PREFER_SIDER_FOR_CHAT=true
DEBUG_ROUTING=false
```

兼容旧变量：

- `ANTHROPIC_BASE_URL` 仅在指向 `deepseek.com` 时兼容为 `DEEPSEEK_BASE_URL`
- `ANTHROPIC_API_KEY` 仅在没有非 DeepSeek 的 `ANTHROPIC_BASE_URL` 干扰时兼容为 `DEEPSEEK_API_KEY`
- `DEFAULT_BACKEND=anthropic` -> `deepseek`

服务端优先使用 `DEEPSEEK_*`。不要把 Claude Code 客户端用的 `ANTHROPIC_BASE_URL=http://localhost:4141` 当作 DeepSeek 上游配置。

不要打印或提交真实 token。

## 核心架构

```text
客户端 Anthropic 请求
  |
  v
认证中间件 AUTH_TOKEN
  |
  v
RouterEngine
  |-- simple_chat -> Sider
  |-- Claude Code tools -> DeepSeek
  |-- MCP/custom tools -> DeepSeek
  |-- tool_result -> 上一回合后端
  v
响应标准化为 Anthropic Messages
```

关键文件：

- `src/routes/messages-hybrid.ts` / `deno/src/routes/messages-hybrid.ts`
- `src/routing/router-engine.ts` / `deno/src/routing/router-engine.ts`
- `src/adapters/anthropic-adapter.ts` / `deno/src/adapters/anthropic-adapter.ts`
- `src/config/backends.ts` / `deno/src/config/backends.ts`
- `src/config/models.ts` / `deno/src/config/models.ts`

## 路由原则

- 普通对话优先 Sider。
- 出现 Claude Code 内置工具（如 `Bash`、`Read`、`Write`、`Edit`、`Task`）必须走 DeepSeek。
- 出现 `mcp__...` 或未知自定义工具必须走 DeepSeek。
- `tool_result` 回合优先延续上一回合后端，避免工具调用上下文断裂。
- 普通对话允许 fallback；工具请求不应 fallback 到 Sider，因为 Sider probe 未证明其支持 Anthropic `tool_use`。
- DeepSeek adapter 需要兼容 `text`、`thinking`、`redacted_thinking`、`tool_use`，真实上游可能在工具请求前返回推理块。
- DeepSeek 对历史工具轮的 thinking passback 校验很严格；请求侧不要把 Claude Code 压缩后的历史 `thinking` / `tool_use` / `tool_result` 结构原样转发，应转成文本上下文。

## 模型清单

两套运行时必须保持一致：

- `src/config/models.ts`
- `deno/src/config/models.ts`

当前对外暴露 18 个 Claude 模型/别名。新增、删除或改映射时，必须同步两份文件并更新 `deno/test/hybrid-routing.test.ts`。

未知 Claude 模型按家族保守映射：

- Opus -> `claude-opus-4.6`
- Haiku -> `claude-haiku-4.5`
- Sonnet -> `claude-sonnet-4.6`

## Sider Probe

probe 脚本：`deno/tools/probe-sider-capabilities.ts`

常用命令：

```bash
deno task probe:sider
```

筛选变量：

```bash
SIDER_PROBE_MODEL=claude-sonnet-4.6
SIDER_PROBE_CASES=simple_chat,anthropic_tool_shape
SIDER_PROBE_CASE_TIMEOUT_MS=20000
SIDER_PROBE_OUTPUT=sider-capability-probe-results.json
```

probe 结论用于更新模型清单和路由策略，但临时 JSON 不应默认提交。

## 测试策略

确定性测试：

- `deno/test/hybrid-routing.test.ts`
- `deno/test/deepseek-adapter.test.ts`

重点覆盖：

- DeepSeek 原生 `tool_use` 能力补齐。
- DeepSeek 响应侧 `thinking` / `redacted_thinking` 透传。
- Claude Code 工具续轮历史转录，避免 DeepSeek `content[].thinking` passback 400。

服务级黑盒测试：

- `test/run-all-tests.ts`
- `test/01-health-check.test.ts`
- `test/02-basic-messages.test.ts`
- `test/03-session-persistence.test.ts`
- `test/04-streaming.test.ts`
- `test/05-token-counting.test.ts`

提交前至少运行：

```bash
npm run test:regression
```

服务级集成测试需要先启动服务：

```bash
bun run dev
npm run test:integration
```

真实外部集成测试允许记录上游行为波动：Sider 配额、active request、timeout 或模型没有复述会话上下文时，要在报告里区分“外部服务行为”与“本服务格式/路由错误”。

## 维护约束

- 不破坏 Anthropic Messages API 响应结构。
- 不把 Sider token 或 DeepSeek key 写入源码、测试输出或文档。
- Deno 与 Node/Bun 双运行时的核心逻辑要同步。
- 修改路由、模型、DeepSeek adapter 时必须补测试。
- `.env` 只作为本地配置输入，不能提交。
