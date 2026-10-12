# Sider2Claude 开发、测试、发布 SOP

按 2026-10-12 代码提交 `451a4f2` 核对。接口和使用说明见[文档目录](README.md)，具体测试说明见[测试指南](../test/TEST-README.md)。

## 1. 准备环境

从仓库根目录运行所有命令。CI 当前固定到 Bun 1.3.x、Deno 2.9.x 次版本；本地同时需要 npm／TypeScript 构建环境。

```bash
npm ci
bun --version
deno --version
node --version
```

服务和两套测试读取同一优先级：运行时变量 > `deno/.env`（不存在才读取根 `.env`）> 默认值。真实凭据与生产地址只存在于本地配置、部署环境或 CI secrets。

客户端 token 是 `AUTH_TOKEN`；Sider 凭据是 `SIDER_AUTH_TOKEN`；原生兼容后端使用 `DEEPSEEK_*`。后端名 deepseek 不代表实际 provider 一定是 DeepSeek。

## 2. 确定变更与验证范围

- 核对工作区、当前提交、两套运行时与相关测试。
- 先用失败测试或真实探测确认问题，再最小修改。
- 模型目录、路由与适配器核心行为同步修改 `src/` 和 `deno/src/`。
- 用文件存在、完整参数、内容哈希或工具反馈等证据验收，不以助手自述代替。
- 原始失败、重跑原因、环境与测试范围一起保留；上游受限不算通过。

当前主控重点见[Sider 主控模式](Sider主控模式.md)：Deno 流式接管需要两个开关，Bun 主控接管全部请求格式；XML 分类在配置了原生兼容后端时走独立路由。

## 3. 本地静态与确定性回归

```bash
npm run test:regression
deno check deno/test/integration/run.ts
npm run build
git diff --check
```

`test:regression` 包含 Deno 全量单测、入口与能力探针检查、TypeScript、Bun 6 个单元测试文件。期望退出码全部为 0。

新增探针也需单独 `deno check`。格式和 lint 使用本轮文件范围；仓库全量 ESLint 当前有历史配置／依赖问题，不能宣称 `npm run lint` 已通过，也不在无关变更中自动升级依赖。

## 4. 启动与零上游冒烟

先核对端口归属；不要直接停止未知进程。服务未加载新配置或启动到旧实例时，健康与鉴权检查可能与预期不符。

```bash
bun run dev
# 或另一个终端中使用 Deno
deno task start
```

未被 `PORT` 覆盖时，Bun 为 4141、Deno 为 8000。PowerShell 示例：

```powershell
Invoke-RestMethod http://localhost:8000/health
$env:TEST_ENV='deno-local'
$env:TEST_API_BASE_URL='http://localhost:8000'
npm.cmd run test:smoke
```

冒烟验证健康、模型、鉴权、CORS 等基础接口，不发生成请求。

## 5. 真实集成门禁

真实回归会消耗上游配额，保持限流，按模型和用例安排执行。所有适用用例要求 `pass == total`、`fail == 0`、`upstream == 0`，不能只看退出码或 HTTP 200。

混合路由实例（服务端 `SIDER_CONTROLLER=false`）运行基础套件 01–13：

```powershell
$env:E2E_BASE_URL='http://localhost:8000'
$env:E2E_CONTROLLER='false'
$env:E2E_REQUIRE_ALL_PASS='true'
$env:E2E_TIMEOUT_MS='600000'
deno task test:e2e
```

主控实例需先在服务端设置 `SIDER_CONTROLLER=true`；Deno 流式用例还需 `SIDER_CONTROLLER_STREAMING=true`。两个独立实例共享对应 KV／SQLite 才能验证跨实例恢复。

```powershell
$env:E2E_BASE_URL='http://localhost:18001'
$env:E2E_CONTROLLER_SECOND_URL='http://localhost:18002'
$env:E2E_CONTROLLER='true'
$env:E2E_REQUIRE_ALL_PASS='true'
$env:E2E_TIMEOUT_MS='1200000'
deno task test:e2e 14 15
```

`E2E_CONTROLLER` 只注册套件，不修改服务器配置；注册后不传套件号会同时包含基础套件，不能把混合路由断言直接套在主控实例上。

上游不足时分析错误与恢复时间，等待后重跑。可以用 `E2E_CASE_PATTERN` 正则选择用例拆分执行；记录实际执行集合及其全绿证据，不能把过滤后的少量用例表述为一次全套通过。

Deno 原始报告写入 `deno/test/integration/reports/`；Bun HTTP runner 报告写入 `test/reports/`。原始报告可能包含目标地址，只保留本地；提交的摘要必须移除生产地址、凭据和正文。

## 6. 提交与推送

用户授权推送后，完成验证和具体变更审查再提交；已获授权的本次范围无需重复确认。

```bash
git status --short --branch
git diff --check
git diff --stat
git diff --cached --check
git commit -m "描述最终变更"
git push origin main
```

暂存前核对范围，不纳入 `.env`、`.runtime/`、运行报告或个人客户端配置。推送后读取远程 main 引用并确认与本地提交一致。

## 7. 部署与生产复验

本项目 main 推送已配置 Deno 自动部署，但 Git 推送成功不等于新部署已上线。通常约一分钟后就绪；按约 15 秒间隔轮询，给部署和冷启动留出至少三分钟窗口。

生产地址通过未跟踪环境或 `DEPLOY_URL` secret 注入。检查：

1. `/health` 返回 200，Deno `version` 的 deployment ID 片段发生变化。
2. 部署平台记录与本次 Git 提交一致；该片段不是 Git 哈希。
3. 健康、模型、鉴权、CORS 冒烟通过。
4. 本次功能的生产定向用例通过；涉及路由／工具／会话／协议时扩展相应范围。
5. 保存不含地址和凭据的验证摘要；失败则继续定位、修复与验证。

```powershell
# TEST_API_BASE_URL 与 TEST_AUTH_TOKEN 在本地或 CI 安全注入
$env:TEST_ENV='deno-deploy'
npm.cmd run test:smoke
```

如需真实生产套件，配置 `E2E_BASE_URL`、`E2E_AUTH_TOKEN` 和严格门禁后，按部署的实际模式选择用例。runner 会输出目标地址，终端原始输出不应提交或公开。

## 8. CI 的实际范围

| 工作流 | 当前行为 |
| --- | --- |
| [ci.yml](../.github/workflows/ci.yml) | main push／PR；Deno 类型、单测、集成及真实客户端入口检查；Bun 类型与单测 |
| [production-verify.yml](../.github/workflows/production-verify.yml) | CI 成功后自动做健康、模型、鉴权和 CORS 冒烟；手动触发可选 Bun HTTP 集成 |

生产工作流需要 `DEPLOY_URL` secret；可选集成另需 `AUTH_TOKEN`。自动冒烟只等待服务返回 200，并不比较部署 ID，也不自动运行 Deno 套件 14／15；不能把它作为全部生产功能已验证的证据。

## 9. 必检行为

- Anthropic Messages 保留请求模型名；Sider 发送基础名，数字窗口标签共享主控与限流状态。
- Anthropic SSE 正常以 `message_stop` 结束；流内 error 是失败，`message_start`／ping 是连接事件。
- 客户端工具块由客户端执行，id 与参数完整保留；成功工具结果续轮回到正确任务。
- XML 分类保留模型真实判定、显式 disabled、停止序列及错误，不伪造允许结果。
- Write 保持严格 JSON、schema、路径与正文校验；回读不匹配不能报告已验证。
- 413 是输入／容量问题，429 按恢复时间退避；错误不能变成空回复或伪造成功。
- 清理只停止本轮创建且已核对归属的进程；`git status` 不包含意外文件。
