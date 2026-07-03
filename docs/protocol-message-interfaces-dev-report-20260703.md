# 多协议消息接口开发报告 2026-07-03

## 目标

在保留 Anthropic `/v1/messages` 主接口的基础上，新增 OpenAI 与 Gemini 兼容入口：

- Anthropic: `POST /v1/messages`
- OpenAI Chat Completions: `POST /v1/chat/completions`
- OpenAI Responses: `POST /v1/responses`
- Gemini GenerateContent: `POST /v1beta/models/{model}:generateContent`
- Gemini StreamGenerateContent: `POST /v1beta/models/{model}:streamGenerateContent`

OpenAI 与 Gemini 的支持由各自 HTTP 入口自动识别，不再依赖全局消息格式开关。 发往 Sider
的内部降级文本固定使用 transcript 格式，避免不同客户端之间互相影响。

## 实现方案

核心策略是“入口多协议，内部单协议”：

1. OpenAI Chat、OpenAI Responses、Gemini 请求先转换为 `AnthropicRequest`。
2. 统一复用现有 `hybridMessagesRouter`，继续沿用 Sider/DeepSeek 混合路由和 fallback 逻辑。
3. 后端返回的 `AnthropicResponse` 再映射回调用方期望的 OpenAI 或 Gemini 响应格式。
4. 流式请求复用 Anthropic SSE，再转换为对应协议的流式事件。

这样没有复制后端调用、鉴权、会话、路由和 fallback 逻辑，改动集中在协议适配层。

## 主要变更

- 新增 `deno/src/utils/protocol-adapters.ts` 与 `src/utils/protocol-adapters.ts`
  - `openAIChatToAnthropic`
  - `openAIResponsesToAnthropic`
  - `geminiToAnthropic`
  - `anthropicToOpenAIChat`
  - `anthropicToOpenAIResponse`
  - `anthropicToGemini`
- 新增 `deno/src/routes/protocols.ts` 与 `src/routes/protocols.ts`
  - 注册 OpenAI Chat、OpenAI Responses、Gemini 原生端点
  - 转发到内部 Anthropic 路由
  - 转换非流式 JSON 与流式 SSE
- 更新 `deno/main.ts` 与 `src/main.ts`
  - 接入协议路由
  - 根信息补充新端点清单
- 新增 `deno/test/protocol-adapters.test.ts`
  - 覆盖三类入站转换和三类出站转换
- 新增 `test/07-protocol-compatibility.test.ts`
  - 覆盖新增端点的非流式与流式服务级集成

## 测试结果

本地离线回归：

- `deno task test`: 25 passed, 0 failed
- `deno check deno/main.ts`: PASS
- `deno check deno/tools/probe-sider-capabilities.ts`: PASS
- `npm.cmd run typecheck`: PASS
- `npm.cmd run test:regression`: PASS

本地 Deno 服务级集成回归：

- 单独协议兼容测试：`07-protocol-compatibility.test.ts` 6/6 PASS
- 完整服务级集成：7/7 PASS
- 最新报告：`test/reports/integration-20260703-225928.md`

完整集成覆盖：

- `01-health-check.test.ts`: PASS
- `02-basic-messages.test.ts`: PASS
- `03-session-persistence.test.ts`: PASS
- `04-streaming.test.ts`: PASS
- `05-token-counting.test.ts`: PASS
- `06-provider-readiness.test.ts`: PASS
- `07-protocol-compatibility.test.ts`: PASS

## 已知边界

- 当前协议适配以文本、reasoning、基础工具调用为主；图片、音频等多模态块尚未做完整协议级映射。
- Gemini 入口当前复用内部模型映射能力，路径中的 `{model}` 会作为内部模型名进入现有路由。
- OpenAI Responses 流式事件覆盖
  `response.created`、`response.output_text.delta`、`response.completed`，暂未实现完整 Responses API
  的所有事件类型。
- 新协议入口共享 Anthropic 主链路鉴权、会话与后端路由能力，不单独引入新的鉴权策略。
