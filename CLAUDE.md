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
deno task test:e2e
deno task probe:sider
```

`npm run test:regression` 是提交前必须跑的确定性回归入口。
`deno task test:e2e` 打的是真实实例（默认 localhost，可用 `E2E_BASE_URL` 指向已部署环境）。

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
  但延续规则带能力守卫：本轮若含 Claude Code 工具或 MCP/自定义工具
  （`hasClaudeCodeTools || hasMcpTools`）而记录的后端是 Sider，必须跳过延续、
  交给工具规则走 DeepSeek。原因是没有显式 `X-Conversation-ID` 的请求共用
  `continuous-conversation` 这一个会话槽位，上一回合很可能是另一段纯对话。
  改动 `rule_1_tool_result_continuity` 时不要把这个守卫去掉。
- 会话后端记忆有 TTL（1 小时）与容量上限（500 条，超出按最近使用淘汰），
  并随 `/v1/messages/conversations/cleanup` 一起回收。
- 普通对话允许 fallback；工具请求不应 fallback 到 Sider，因为 Sider probe 未证明其支持 Anthropic `tool_use`。
- Sider 用 `HTTP 200 + SSE 内 code != 0` 表达业务失败（如 1135 用量超限）。
  这类失败必须转成 `SiderUpstreamError` 上抛（1135 -> 429，其余 -> 502），
  非流式据此触发 fallback，流式在流内发 Anthropic `error` 事件。
  判定保守：仅当收到非 0 code 且完全没拿到文本时才判失败。
- 协议层（OpenAI / Gemini）的流式映射必须透传 Anthropic `error` 事件，
  否则上游失败时客户端只会收到空流 + `[DONE]`。
- 重复响应缓存只服务非流式路径。请求指纹刻意忽略 `stream` 字段（用于跨
  流式/非流式识别客户端重试的观测语义），因此缓存键必须额外带流式标记，
  不能让非流式请求回放流式响应。
- DeepSeek adapter 需要兼容 `text`、`thinking`、`redacted_thinking`、`tool_use`，真实上游可能在工具请求前返回推理块。
- DeepSeek 对历史工具轮的 thinking passback 校验很严格；请求侧不要把 Claude Code 压缩后的历史 `thinking` / `tool_use` / `tool_result` 结构原样转发，应转成文本上下文。

## 模型清单

两套运行时必须保持一致：

- `src/config/models.ts`
- `deno/src/config/models.ts`

当前对外暴露 67 个模型/别名，其中 Claude 家族 26 个，其余为 Sider 支持的
GPT / Gemini / DeepSeek / Grok / GLM / Qwen / Kimi / Llama 上游模型。
新增、删除或改映射时，必须同步两份文件并更新 `deno/test/hybrid-routing.test.ts`
与 `deno/test/model-exposure.test.ts` 里的计数与 id 断言。

两个文件内容应保持逐字一致。Claude 家族用 `model(id, siderModel)` 声明，
只有对外名与 Sider 名不同时才写第二个参数；其余上游模型放在
`SIDER_UPSTREAM_MODELS` 字符串数组里（这些模型对外名与 Sider 名一致）。

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

确定性测试（mock 上游，`deno task test`）：

- `deno/test/hybrid-routing.test.ts`
- `deno/test/deepseek-adapter.test.ts`
- `deno/test/sider-upstream-error.test.ts`
- `deno/test/duplicate-cache-isolation.test.ts`
- `deno/test/messages-hybrid-stream.test.ts`

重点覆盖：

- DeepSeek 原生 `tool_use` 能力补齐。
- DeepSeek 响应侧 `thinking` / `redacted_thinking` 透传。
- Claude Code 工具续轮历史转录，避免 DeepSeek `content[].thinking` passback 400。
- Sider 的 SSE 内业务错误码（如 1135 用量超限）必须上抛，不能吞成空回复。
- 带工具的 `tool_result` 续轮不得被会话延续规则路由回 Sider。
- 重复响应缓存按流式隔离，流式响应不得被等价非流式请求回放。

Deno 集成回归测试库（打真实实例，`deno task test:e2e`）：

- 入口 `deno/test/integration/run.ts`，10 个套件，可传套件号只跑其中几个。
- 目标地址用 `E2E_BASE_URL` 覆盖，默认 `http://localhost:$PORT`。
- 套件 06 模拟 Claude Code 的真实调用形态，对一个 Sonnet 与一个 Opus
  各跑一遍完整 agent 循环，验证持续对话与连续工具调用。
- 报告写入 `deno/test/integration/reports/`（已 gitignore）。

结果分三态：`pass` / `fail` / `upstream`。上游受限（Sider 配额、DeepSeek
网络抖动）归入 `upstream`，单独列出且不计入失败、不影响退出码——这样上游
波动不会把回归门禁刷红。退出码只看 `fail`。

服务级黑盒测试（Node 侧，`test/` 目录）：

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
