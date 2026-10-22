# 测试使用指南

所有命令从仓库根目录运行。当前代码核对基线为 2026-10-12、`451a4f2`。

## 测试分层

| 入口 | 是否需服务 | 上游消耗 | 范围 |
| --- | --- | --- | --- |
| `npm run test:regression` | 否 | 无真实上游 | Deno 全量、主入口／probe 检查、TypeScript、Bun 单测 |
| `npm run test:smoke` | 是 | 无生成调用 | 健康、模型、CORS、鉴权、请求校验 |
| `deno task test:e2e` | 是 | 是 | 真实 HTTP 与协议／工具／主控套件 |
| `npm run test:integration` | 是 | 是 | Bun HTTP runner，自动发现 `test/01–07` 文件 |
| `deno task probe:sider` | 否，直连上游 | 是 | 按需探测 Sider 能力 |

`test:regression` 最后的 Bun 单测包括 adapter、request-converter、server-tools、upstream-timeout、write-integrity、sider-controller 六个文件。它们通过 mock fetch 验证协议和异常边界；“真实 HTTP”单测可使用本地环回服务，但不会消耗真实上游。

## 确定性回归

```bash
npm run test:regression
deno check deno/test/integration/run.ts
npm run build
```

当前代码基线验证结果为 Deno 352/352、Bun 49/49。新增测试后以本次输出为准，不把这些数量当成永久固定断言。

模型标签、分类与长请求的重点测试：

- `deno/test/model-context-window.test.ts`：发送边界、限流与 161 消息／27 工具。
- `deno/test/model-exposure.test.ts`：目录及普通 HTTP／SSE。
- `deno/test/safety-classifier.test.ts`：大 system 分类旁路、disabled、真实判定、停止序列及错误。
- `deno/test/sider-controller.test.ts` 与 `test/sider-controller.unit.test.ts`：检查点、重放、正文与双运行时行为。

## 配置优先级

两个测试入口都优先用运行时环境；dotenv 从 `deno/.env` 读取，不存在才读根 `.env`，两份不合并。测试必须与服务使用匹配的 `AUTH_TOKEN`。

| 变量 | Deno 真实集成入口 |
| --- | --- |
| `E2E_BASE_URL` | 目标地址；其次 `TEST_API_BASE_URL`，最后 localhost 的 `PORT`／8000 |
| `E2E_AUTH_TOKEN` | 认证；其次 `TEST_AUTH_TOKEN`、`AUTH_TOKEN` |
| `E2E_TIMEOUT_MS` | 单请求超时，默认 120000 毫秒；长分段可显式放宽 |
| `E2E_LIVE_MODEL` | 默认 `claude-haiku-4.5` |
| `E2E_CC_SONNET_MODEL`、`E2E_CC_OPUS_MODEL` | 套件 06 默认 `claude-sonnet-4.6`、`claude-opus-4.8` |
| `E2E_REQUIRE_ALL_PASS` | 发布时设 `true`，upstream 也使退出码非零 |
| `E2E_CONTROLLER` | 为 true 时注册 14–17；不修改服务端开关 |
| `E2E_CONTROLLER_SECOND_URL` | 共享存储的第二独立主控实例 |
| `E2E_CASE_PATTERN` | 用例名正则筛选，忽略大小写；没有匹配时退出码为 2 |
| `E2E_REPORT_DIR` | 默认 `deno/test/integration/reports` |

基础路由套件和主控套件须分别指向适配模式的服务器。`E2E_CONTROLLER=true` 且不指定套件时，会注册并选择 01–17，不代表这些路由断言都适用于同一个主控实例。

## Deno 真实集成套件

| 套件 | 范围 |
| --- | --- |
| 01 | 基础设施、用量、会话接口 |
| 02 | 模型目录及发现 |
| 03 | 非流式对话、system、历史和模型映射 |
| 04 | SSE 事件、正文、结束与错误 |
| 05 | 工具调用及路由 |
| 06 | Sonnet／Opus 多轮 agent 循环 |
| 07 | OpenAI Chat／Responses |
| 08 | Gemini 生成／流式 |
| 09 | Legacy complete／token 计数 |
| 10 | 鉴权及错误格式 |
| 11 | 客户端内容块、搜索与 PPT 资料工具循环 |
| 12 | 51 消息／18 工具的长历史 |
| 13 | 12 项长 JSON Write 完整性 |
| 14 | Sider 主控循环、长正文、分段、缓存与跨实例 |
| 15 | cc-switch 窗口切换、重放／续轮与 XML 分类 |
| 16 | 超过16片的完整上下文、尾部续传及内容库容量 |
| 17 | 有效流式配置、视觉旁路、实际SSE文件复制与统计重放 |

默认基础套件 01–13 当前共 88 项。套件14通常12项，设置第二实例时增加一项；套件15共3项，16共2项，17共4项。实际数量以runner输出为准。

混合实例先设置服务端 `SIDER_CONTROLLER=false` 并启动，然后：

```powershell
$env:E2E_BASE_URL='http://localhost:8000'
$env:E2E_CONTROLLER='false'
$env:E2E_REQUIRE_ALL_PASS='true'
$env:E2E_TIMEOUT_MS='600000'
deno task test:e2e
# 也可指定套件
deno task test:e2e 11 12 13
```

主控测试服务须配置 `SIDER_CONTROLLER=true`，并确认状态接口的流式有效值为true。两实例共享对应存储，按账号串行并保持节奏；不要混用 Deno KV 与 Bun SQLite 验证跨实例恢复。正常本地工具流程与部署期限／小批登记分别选用对应环境。

```powershell
$env:E2E_BASE_URL='http://localhost:18001'
$env:E2E_CONTROLLER_SECOND_URL='http://localhost:18002'
$env:E2E_CONTROLLER='true'
$env:E2E_REQUIRE_ALL_PASS='true'
$env:E2E_TIMEOUT_MS='1200000'
deno task test:e2e 14 15
```

套件15的分类、套件17的视觉用例需要真实兼容后端配置。套件14的工具反馈主要使用合成数据，套件17会实际执行受限目录内的Read／Write并校验文件字节；它不等于完整ppt-master导出。

按配额拆分执行时，可显式设置筛选：

```powershell
$env:E2E_CASE_PATTERN='XML分类'
deno task test:e2e 15
Remove-Item Env:E2E_CASE_PATTERN
```

记录筛选条件、执行集合及所有结果；不能将未运行或受限的用例算作通过。

## 严格通过与报告

结果为 pass、fail、upstream。未开启严格门禁时，upstream 可以不影响退出码；发布必须设置 `E2E_REQUIRE_ALL_PASS=true` 并确认通过数等于执行总数、失败和受限都为 0。429 在不同用例中也可能记为 fail，需读取具体错误，而非只看分类计数。

报告在 `deno/test/integration/reports/` 自动生成；目标地址会出现在原始报告和终端中，因此只留本地。提交摘要去掉私有地址、凭据及正文。

代码 `451a4f2` 的证据为基础 88/88、新套件 15 为 3/3，两次均无失败或受限；这 91 项不包含当次未重跑的主控套件 14。详见[修复报告](../docs/cc-switch上下文窗口兼容修复_20261012.md)。

## Bun HTTP runner 与冒烟

Bun 默认目标为 `http://localhost:4141`；Deno 目标用运行时覆盖：

```powershell
$env:TEST_ENV='deno-local'
$env:TEST_API_BASE_URL='http://localhost:8000'
# TEST_AUTH_TOKEN 未设时读取 AUTH_TOKEN
npm.cmd run test:smoke
npm.cmd run test:integration
```

可用 `TEST_ENV`：bun-local、deno-local、deno-deploy。远端地址由 `TEST_API_BASE_URL` 或 `DENO_DEPLOY_URL` 注入。

HTTP runner 自动发现带序号的文件，当前 01–07 包含健康、基础消息、会话、SSE、token、provider 准备度及多协议兼容。只选文件：

```bash
bun run test/run-all-tests.ts 01-health-check.test.ts 05-token-counting.test.ts
```

报告在 `test/reports/integration-*.md`。此 runner 与 Deno 真实集成库是不同入口，不要混用配置变量或结果统计。

## CI 与生产

[CI](../.github/workflows/ci.yml)覆盖确定性测试及入口类型检查。[生产验证](../.github/workflows/production-verify.yml)在 CI 成功后自动做冒烟，手动触发可选 Bun HTTP 集成；它不自动执行 Deno 主控／窗口套件，也不比较部署 ID。

推送后的部署确认、生产定向用例与报告要求见[发布 SOP](../docs/开发测试发布SOP.md)。
