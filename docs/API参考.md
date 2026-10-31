# API 参考

本文说明 2026-10-12 代码提交 `451a4f2` 的接口和行为。所有示例使用本地地址；部署地址和凭据由运行环境提供。

## 地址与鉴权

Base URL 不附加单个接口路径，例如 `http://localhost:4141`。生成请求、会话管理与后端状态接口接受以下任一种鉴权：

```http
Authorization: Bearer your-client-token
```

```http
x-api-key: your-client-token
```

同时提供时优先使用 `x-api-key`；其值应匹配服务端 `AUTH_TOKEN`。`dummy` 仅在服务端明确设置 `ALLOW_DUMMY_TOKEN=true` 时接受。

服务端未配置 `AUTH_TOKEN` 时默认失败关闭：受保护端点返回 503 `AUTH_NOT_CONFIGURED`。只有显式设置 `ALLOW_OPEN_AUTH=true`（仅限本地开发）才接受任意 ≥10 字符的 token。客户端 token 默认不会转发给 Sider；需要旧行为时设置 `SIDER_TOKEN_PASSTHROUGH=true`。

| 凭证 | 用途 |
| --- | --- |
| `AUTH_TOKEN` | 调用 `/v1/*`；也可读看板 |
| `ADMIN_TOKEN` | `POST /stats/strategy`；未配置时回退 `AUTH_TOKEN`；也可读看板 |
| `STATS_TOKEN` | 只读看板 `/stats`、`/stats.json`、`/stats/telemetry.json` |

浏览器打开 `/stats` 时先显示登录页，提交看板凭证后换取 12 小时有效的 HttpOnly 会话 cookie。`STATS_PUBLIC=true` 可恢复看板公开访问。请求体上限默认 32 MB（`MAX_REQUEST_BODY_BYTES`），超出返回 413 `request_too_large`。

OpenAI／Gemini 转换路径当前转发 `Authorization` 和 `x-api-key`；未实现 `x-goog-api-key`／URL `key` 鉴权转换。

## 端点

| 方法与路径 | 鉴权 | 用途 |
| --- | --- | --- |
| GET `/`、`/health` | 无 | 服务信息、健康及版本（`/` 不再包含用量数据） |
| GET `/v1/models`、`/v1/models/:model_id` | 无 | 模型目录与详情 |
| POST `/v1/messages` | 是 | Anthropic Messages |
| POST `/v1/messages/count_tokens` | 是 | 输入 token 估算 |
| POST `/v1/chat/completions` | 是 | OpenAI Chat 请求转换 |
| POST `/v1/responses` | 是 | OpenAI Responses 请求转换 |
| GET `/v1beta/models`、`/v1beta/models/:model` | 无 | Gemini 形式的模型发现 |
| POST `/v1beta/models/:model:generateContent` | 是 | Gemini 生成请求转换 |
| POST `/v1beta/models/:model:streamGenerateContent` | 是 | Gemini 流式转换 |
| POST `/v1/complete` | 是 | Legacy completion |
| GET `/v1/messages/backends/status` | 是 | 后端配置与路由状态 |
| GET `/v1/messages/conversations`、`/v1/messages/sider-sessions` | 是 | 进程内普通会话信息 |
| POST `/v1/messages/conversations/cleanup`、`/v1/messages/sider-sessions/cleanup` | 是 | 清理对应过期会话信息 |
| GET `/stats`、`/stats.json` | 看板凭证或登录 cookie | 用量看板及快照 |
| POST `/stats/login`、`/stats/logout` | 登录提交看板凭证 | 浏览器看板会话 |
| POST `/stats/strategy` | 管理凭证，Deno 独有 | 设置 `conservative/pro/max` |
| GET `/stats/telemetry.json` | 看板凭证，Deno 独有 | 导出不含正文的 Sider 调用遥测 |

普通会话管理端点不是主控任务／正文库的删除接口。主控通过专用 KV／SQLite 检查点恢复。

## Messages 请求

```json
{
  "model": "claude-sonnet-5.5[1m]",
  "max_tokens": 1024,
  "stream": false,
  "system": "请用中文回答。",
  "messages": [
    {"role": "user", "content": "说明项目的主要用途。"}
  ]
}
```

| 字段 | 当前处理 |
| --- | --- |
| `model` | 必填。Sider 查找和发送规范化数字窗口标签；兼容后端使用配置的上游模型；对外响应保留请求名 |
| `messages` | 必填非空数组，需包含 user 消息。content 可为文本或受支持内容块 |
| `system` | 支持文本；HTTP 规范化也会合并文本块数组及部分 OpenAI 风格 system/developer 消息 |
| `max_tokens` | 转发到原生兼容后端；Sider 通道不承诺同等输出预算控制 |
| `stream` | 为 true 时返回 SSE，运行时与路由决定是真实流还是校验后合成流 |
| `tools` | 客户端声明的工具名称、描述与 JSON Schema |
| `tool_choice` | 支持 auto、any、tool、none；主控校验强制选择，兼容适配器对 tool 使用文本提示兼容、对 none 隐藏工具 |
| `thinking` | 显式 disabled 在兼容后端 JSON／流式路径兑现；其他 thinking 参数按上游兼容处理，不代表 Sider 原生预算能力 |
| `stop_sequences` | 正文层处理，不截 thinking 或结构化工具参数；匹配时改判 stop_sequence |

Sider 主控的单个请求每轮最多一个客户端工具意图；模型选择内部正文操作时，代理可在同一请求内继续内部保存／引用流程。

非流式响应主要字段为 `id/type/role/model/content/stop_reason/usage`。客户端可见内容块为 `text`、`thinking`、`redacted_thinking`、`tool_use`；兼容上游服务端工具调用与结果转换为文本记录。

Sider 响应可附带 `sider_session`。`conversation_id` 在普通 Sider 路径是上游会话标识，在主控路径是代理任务标识；调用方应原样回传，不能混用两种标识。

## 模型与上下文标签

当前 `GET /v1/models` 返回 106 个目录条目。数字窗口后缀如 `[1M]`、`[200k]` 不新增目录项；详情查询返回对应基础条目。

混合路由保留未知 Claude 名称的家族映射；主控要求明确登记的基础模型，否则返回 400。普通 Opus／Haiku／Sonnet 家族兜底分别为 `claude-opus-5.5`、`claude-haiku-5.5`、`claude-sonnet-5.5`；thinking 名称有独立映射，以配置代码为准。

窗口标签只影响客户端声明。Sider 的实际输入限制与配额、兼容上游的实际上下文容量仍由对应后端决定。

## 工具循环

首次请求声明工具：

```json
{
  "model": "claude-sonnet-5.5",
  "max_tokens": 1024,
  "messages": [{"role": "user", "content": "读取 C:/project/config.json。"}],
  "tools": [{
    "name": "Read",
    "input_schema": {
      "type": "object",
      "properties": {"file_path": {"type": "string"}},
      "required": ["file_path"]
    }
  }]
}
```

返回 `tool_use` 与 `stop_reason=tool_use` 后，由客户端执行对应工具。下一轮保留助手工具块及关联结果：

```json
[
  {
    "role": "assistant",
    "content": [{
      "type": "tool_use", "id": "toolu_example", "name": "Read",
      "input": {"file_path": "C:/project/config.json"}
    }]
  },
  {
    "role": "user",
    "content": [{
      "type": "tool_result", "tool_use_id": "toolu_example",
      "content": "{\"port\":8080}"
    }]
  }
]
```

示例 id 仅示意；实际续轮必须使用服务返回的 id，并保留当前会话的历史。工具失败使用 `is_error=true`。主控会校验任务归属、pending id 及 schema；已处理或外来结果返回 400。

主控无需客户端回传自定义头也能从工具 id／历史恢复；显式单消息续轮可使用 `?cid=` 或 `X-Conversation-ID`。`X-Parent-Message-ID` 用于普通 Sider 路径，主控以自己的检查点为准。

## 流式响应

Anthropic SSE 的正常序列：

```text
event: message_start
data: {"type":"message_start","message":{"id":"msg_example","model":"claude-sonnet-5.5","content":[]}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"回答"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}

event: message_stop
data: {"type":"message_stop"}
```

可夹带 ping；工具参数通过 `input_json_delta` 增量发送，在对应内容块闭合后解析完整 JSON。主控流内容块在完整校验后发出。

Anthropic Messages 以 `message_stop` 正常结束，不能用 OpenAI 的 `[DONE]` 判断其成功。流内 `error` 即失败，即使 HTTP 已返回 200 或先收到 `message_start`。

OpenAI Chat 转换输出 chunk 与 `[DONE]`；Responses 转换输出 response 事件。当前 Gemini 流式使用共享映射器，末尾也包含 `[DONE]`，该行为与原生 Gemini SSE 不完全相同，接入 SDK 时应核对消费方式。

## XML 安全分类

无工具且 system 同时声明 classifier／classification／安全分类及 `<block>`／`<severity>` 时，配置的原生兼容后端优先处理，包括主控开启时。该规则名为 `rule_0_safety_classifier`，不回退 Sider。

模型实际判定、停止序列及错误交回调用方；代理不会生成默认允许判定。调用方的 `thinking: disabled` 会被兑现，适合小预算分类。没有配置兼容后端时，此专用路由不生效，不能据此承诺分类可用。

## 状态码与排查

| 状态 | 当前语义 |
| --- | --- |
| 400 | 请求结构、严格主控模型、工具归属或参数等问题 |
| 401 | 缺少或不匹配的客户端 token |
| 404 | 路径或模型详情不存在 |
| 413 | Sider 603、主控新增输入／分段／正文容量超限 |
| 429 | 上游用量限制或主控排队／冷却；非流式读取 Retry-After |
| 502 | Sider 协议、主控确认／校验或其他上游故障 |
| 503 | 缺少主控凭据、兼容后端空闲／总时长超时等 |

部分普通路径未知异常返回 500；错误归因以 `error.message` 与 requestId 为准。典型生成错误体：

```json
{"type":"error","error":{"type":"rate_limit_error","message":"上游限制说明"}}
```

鉴权中间件等错误体可能另带 `error.code`。流开始后无法修改 HTTP 状态，应读取 SSE error；不要将 200 当成所有内容块和工具调用均有效。

主控响应有 `X-Sider-Controller: true` 与 `X-Backend-Used: sider`。混合路径的后端／规则头通常需 `DEBUG_ROUTING=true`；路径之间的诊断头并不完全相同。

Deno CORS 允许 Anthropic 与会话诊断请求头；Bun 当前全局 CORS 只显式允许 `Content-Type` 和 `Authorization`。浏览器跨域客户端与本地 CLI 的使用条件不同。

## 其他协议示例

OpenAI Chat：

```json
{"model":"claude-sonnet-5.5","messages":[{"role":"user","content":"你好"}],"max_tokens":128}
```

Responses：

```json
{"model":"claude-sonnet-5.5","input":"你好","max_output_tokens":128}
```

Gemini generateContent：

```json
{"contents":[{"role":"user","parts":[{"text":"你好"}]}],"generationConfig":{"maxOutputTokens":128}}
```

这些请求共用后端路由；当前只实现代码中列出的转换字段，其他原生厂商扩展应单独验证。Legacy complete 的 `prompt` 必填；token 计数和 Sider usage 是兼容估算，不能用作厂商精确计费依据。
