# 测试套件使用指南

本目录保留服务级黑盒集成测试；Deno 确定性单测位于 `deno/test`。

## 测试分层

| 层级 | 命令 | 是否需要服务 | 说明 |
| --- | --- | --- | --- |
| Deno 单测 | `deno task test` | 否 | 路由、模型映射、DeepSeek adapter |
| Deno 检查 | `deno task check` | 否 | Deno 主入口类型检查 |
| Probe 检查 | `deno check deno/tools/probe-sider-capabilities.ts` | 否 | probe 脚本类型检查 |
| Node/Bun 类型检查 | `npm run typecheck` | 否 | `src/` TypeScript 检查 |
| 完整确定性回归 | `npm run test:regression` | 否 | 以上四项串联 |
| 服务级集成 | `npm run test:integration` | 是 | 调用已启动的 HTTP 服务 |

## 服务级集成测试

先启动服务：

```bash
# Bun，默认 http://localhost:4141
bun run dev
```

再运行：

```bash
npm run test:integration
```

Deno 本地服务：

```bash
# 终端 1
deno task dev

# 终端 2
$env:TEST_ENV="deno-local"
$env:TEST_API_BASE_URL="http://localhost:8000"
npm run test:integration
```

## 环境配置

测试配置读取优先级：

1. 运行时环境变量
2. 根目录 `.env`
3. 测试默认值

常用变量：

| 变量 | 说明 |
| --- | --- |
| `TEST_ENV` | `bun-local`、`deno-local`、`deno-deploy` |
| `TEST_API_BASE_URL` | 覆盖 API 地址 |
| `TEST_AUTH_TOKEN` | 覆盖测试请求 token |
| `AUTH_TOKEN` | 未设置 `TEST_AUTH_TOKEN` 时作为测试 token |

测试日志只输出 token 掩码。

## 测试文件

| 文件 | 覆盖内容 |
| --- | --- |
| `01-health-check.test.ts` | 健康检查、CORS |
| `02-basic-messages.test.ts` | 模型列表、基础消息、认证、无效请求 |
| `03-session-persistence.test.ts` | 会话创建、多轮对话、会话端点 |
| `04-streaming.test.ts` | Anthropic SSE 流式响应 |
| `05-token-counting.test.ts` | `/v1/messages/count_tokens` |

`03-session-persistence.test.ts` 的多轮语义断言会检查 Sider 上游是否在第二轮复述测试上下文。即使服务端已拿到会话 ID 且 `sider-sessions` 记录了多条消息，上游模型仍可能不按测试预期回答；报告中应单独标注这类外部语义波动。

统一 runner：

```bash
bun run test/run-all-tests.ts
```

只跑指定文件：

```bash
bun run test/run-all-tests.ts 01-health-check.test.ts 05-token-counting.test.ts
```

## 批处理入口

Windows：

```bat
test\run-tests.bat
test\run-tests-bun.bat
test\run-tests-deno-local.bat
test\run-tests-deno-deploy.bat
```

Linux/macOS：

```bash
test/run-tests.sh
test/run-tests-bun.sh
test/run-tests-deno-local.sh
test/run-tests-deno-deploy.sh
```

## 常见失败原因

- 服务未启动：`ECONNREFUSED`。
- `AUTH_TOKEN` 不一致：返回 401。
- Sider 配额不足：普通对话可能返回空文本或用量限制。
- DeepSeek key 未配置或不是官方 DeepSeek key：工具请求会失败或无法补齐 `tool_use`。
- DeepSeek 返回 `thinking` 内容块：当前 adapter 已支持；如果再次出现未知块类型，应补充类型和确定性测试。
- 远端部署地址未设置：请用 `TEST_API_BASE_URL` 或 `DENO_DEPLOY_URL` 指定。
