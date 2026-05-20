# Sider2Claude Deno 版本

这是 Sider2Claude 的 Deno/Hono 入口，可用于本地运行或部署到 Deno Deploy。

当前方案：

- 普通 Claude 对话走 Sider。
- Claude Code 工具、MCP 工具、自定义 `tool_use` 走 DeepSeek Anthropic 兼容接口。
- DeepSeek 默认模型为 `deepseek-v4-flash`。
- DeepSeek 的响应侧 `thinking`、`redacted_thinking`、`tool_use` 内容块会按 Anthropic Messages 结构透传。
- 发往 DeepSeek 的历史工具轮会先转录为文本，避免上游要求完整 `content[].thinking` passback 而返回 400。

## 快速启动

从仓库根目录运行：

```bash
deno task dev
```

默认端口为 `8000`，可通过 `.env` 或环境变量覆盖：

```env
PORT=8000
AUTH_TOKEN=your-client-token
SIDER_AUTH_TOKEN=your-sider-jwt
DEEPSEEK_BASE_URL=https://api.deepseek.com/anthropic
DEEPSEEK_API_KEY=your-deepseek-key
DEEPSEEK_MODEL=deepseek-v4-flash
DEFAULT_BACKEND=sider
AUTO_FALLBACK=true
PREFER_SIDER_FOR_CHAT=true
```

检查：

```bash
curl http://localhost:8000/health
curl http://localhost:8000/v1/messages/backends/status \
  -H "Authorization: Bearer your-client-token"
```

## 环境变量

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `AUTH_TOKEN` | 客户端访问本服务的 token | 无 |
| `SIDER_AUTH_TOKEN` | 访问 Sider 的 JWT | 无 |
| `SIDER_API_URL` | Sider completions 端点 | `https://sider.ai/api/chat/v1/completions` |
| `DEEPSEEK_BASE_URL` | DeepSeek Anthropic 兼容入口 | `https://api.deepseek.com/anthropic` |
| `DEEPSEEK_API_KEY` | DeepSeek API Key | 无 |
| `DEEPSEEK_MODEL` | DeepSeek 工具能力补齐模型 | `deepseek-v4-flash` |
| `DEFAULT_BACKEND` | 默认后端，支持 `sider` / `deepseek` | `sider` |
| `AUTO_FALLBACK` | 普通对话失败时是否自动降级 | `true` |
| `PREFER_SIDER_FOR_CHAT` | 普通对话是否优先 Sider | `true` |
| `DEBUG_ROUTING` | 是否输出详细路由决策 | `false` |
| `REQUEST_TIMEOUT` | 请求超时毫秒数 | `30000` |

兼容旧部署变量：

- `ANTHROPIC_BASE_URL` 仅在指向 `deepseek.com` 时作为 `DEEPSEEK_BASE_URL` 旧别名。
- `ANTHROPIC_API_KEY` 仅在没有非 DeepSeek 的 `ANTHROPIC_BASE_URL` 干扰时作为 `DEEPSEEK_API_KEY` 旧别名。
- `DEFAULT_BACKEND=anthropic` 会兼容映射为 `deepseek`。

推荐使用 `DEEPSEEK_*` 显式配置工具能力兜底，避免和 Claude Code 客户端变量混淆。

## 路由规则

```text
simple_chat                 -> Sider
Claude Code tools           -> DeepSeek
MCP/custom tools            -> DeepSeek
tool_result continuation    -> 上一回合后端
Sider native tools only     -> Sider，可 fallback
```

DeepSeek 工具续轮注意事项：

- 新工具请求保留 `tools`，由 DeepSeek 原生返回 `tool_use`。
- 历史 `thinking` / `redacted_thinking` / `tool_use` / `tool_result` 内容块转发前转录为普通文本。
- 响应侧仍透传结构化 `thinking` 和 `tool_use`，供 Claude Code 继续解析。

## Probe

运行 Sider 能力探测：

```bash
deno task probe:sider
```

常用筛选：

```bash
$env:SIDER_PROBE_MODEL="claude-sonnet-4.6"
$env:SIDER_PROBE_CASES="simple_chat,anthropic_tool_shape"
$env:SIDER_PROBE_CASE_TIMEOUT_MS="20000"
deno task probe:sider
```

probe 会从根目录 `.env` 读取 `SIDER_AUTH_TOKEN`，不会输出 token。

## 回归测试

确定性回归：

```bash
deno task regression
```

完整仓库回归：

```bash
npm run test:regression
```

真实服务级集成测试中，健康检查、模型列表、基础消息、流式响应、token 计数和 DeepSeek 工具路径应通过。DeepSeek 工具路径还应覆盖带历史 `tool_use` / `tool_result` 的续轮请求。`03-session-persistence` 的多轮语义断言依赖 Sider 上游是否复述测试上下文，可能出现模型行为层面的波动。

服务级集成测试需要先启动服务，然后在另一个终端运行：

```bash
$env:TEST_ENV="deno-local"
$env:TEST_API_BASE_URL="http://localhost:8000"
npm run test:integration
```

## 部署到 Deno Deploy

入口文件：`deno/main.ts`

建议配置：

```env
AUTH_TOKEN=your-client-token
SIDER_AUTH_TOKEN=your-sider-jwt
DEEPSEEK_BASE_URL=https://api.deepseek.com/anthropic
DEEPSEEK_API_KEY=your-deepseek-key
DEEPSEEK_MODEL=deepseek-v4-flash
DEFAULT_BACKEND=sider
AUTO_FALLBACK=true
PREFER_SIDER_FOR_CHAT=true
```

## API 端点

- `GET /health`
- `GET /`
- `GET /v1/models`
- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- `GET /v1/messages/backends/status`
- `GET /v1/messages/conversations`
- `GET /v1/messages/sider-sessions`
- `POST /v1/complete`
