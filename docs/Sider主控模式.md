# Sider 主控模式

此模式由 `SIDER_CONTROLLER=true` 显式启用，让 Sider 负责规划、创作、工具选型及结果判断。代理把经过校验的工具意图转换成 Anthropic `tool_use`，实际操作由 Claude Code／MCP 客户端执行。

## 实证依据

2026-10-07 对 Sider 的 57 次探测证明 Opus 5.5、Sonnet 5.5 可以通过明确文本工具契约生成 Read、Write、MCP 和嵌套参数，并能处理失败结果后更换工具。上游拒绝已测的 Anthropic 自定义工具定义，不能直接传入标准 tools 数组。

2026-10-08 补测 StoreContent→本地真实保存与 SHA-256→同一会话 WriteFromRef，两模型共四轮校验通过；规范与完整工具表分段登记后，两模型均可按唯一随机路径正确调用 Read。大上下文实际集成使用 39,111 字符规范，保留全部内容及工具定义。

首次大上下文集成暴露“先登记工具，再登记长规范”会使上游无法稳定使用工具定义。实现改为先登记上下文，在执行前提供可容纳的完整 schema。只有单个请求放不下的工具表才完整分段登记；每轮仍提示合法工具名，参数纠正时重新提供相关工具的完整定义。原始失败记录保留在本次验证报告中。

真实 Claude Code 2.1.195 使用 JSON Schema 2020-12，已用实际工具定义修复方言校验，并完成 12 项长 JSON 的实际 Read→Write 文件复制验证。完成判断要求文件存在、正文逐字一致及客户端 Write 成功反馈，不能只看助手自述。

## 工作流程

1. 请求通过项目现有认证中间件后，进入独立主控路径；`pro/max/conservative` 的既有行为仍由原路由负责。
2. 按调用者凭证摘要隔离任务，使用代理生成的唯一工具 ID 查找持久化检查点。Claude Code 无需回传自定义会话头。
3. 首轮把 system、历史和当前需求完整发送。大内容按已验证的真实 `cid + parent_message_id` 分段登记，禁止截断 schema 或用模型摘要替代原始规范。
4. 续轮只发送最新助手之后的用户输入与工具结果，保留结果 ID、错误标记及内容；不会因为旧历史长就提前转给 GLM。
5. Sider 每轮输出最多一个文本工具意图。代理仅接受严格 JSON，并按客户端声明的工具名和 schema 校验，不转换类型、不删字段、不补默认值。
6. 合法意图转成客户端工具块；实际操作完成后，结果回到同一个 Sider 会话。重试同一请求可重放持久化结果及原工具 ID。

## 长正文与文件写入

提供 Write 的客户端会话可以使用代理内部 StoreContent 和 WriteFromRef。它们不会暴露为客户端需要执行的工具。

- StoreContent 保存 Sider 创作的完整正文，分块落库后计算 SHA-256，返回任务内的正文引用。
- WriteFromRef 核验调用者、任务归属、分块和哈希，然后装配成客户端声明的 Write。
- 引用不能跨任务使用，过期、缺块或哈希错误会明确拒绝。
- 正文保存成功不等于文件写入成功。在提交真正的 Write 前，不能把“文件已完成”当作最终回答。
- 直接 Write 同样要求路径和正文类型正确；文件内容的业务正确性仍由任务要求和客户端校验确认。

针对实测出现的 Read→Write 复制重复转义，代理可从完整 Read JSON 的连续“行号＋制表符”展示格式提取正文，直接保存为引用。在明确“逐字复制／原样复制”的任务中，禁止模型重新生成该源正文。仅支持已测的完整合法 JSON 展示，不猜测缺失行号、截断结果或坏 JSON。

Read 展示未提供原文件编码、CRLF及末尾换行的完整信息；该提取不能保证任意文件的字节级复制。本次逐字验证针对 UTF-8、LF、无额外末尾换行的 JSON 文件。其他精确文件复制应由客户端文件复制工具执行，不能让代理猜测原始字节。

对于用户明确要求逐字保留的复杂命令，可以用以下形式提供原文，代理会比较实际 Bash.command，发现改写则交回 Sider 纠正：

```text
<command>
需要逐字执行的单行命令
</command>
```

这项保护只对明确标记的命令原文生效，不能保证所有自然语言描述的命令语义正确。

## 配置

Deno 配置模板：`config/sider-controller.deno.env.example`。
Bun 配置模板：`config/sider-controller.bun.env.example`。
Claude Code 客户端模板：`config/claude-code.sider-controller.json.example`。

将相应服务端变量叠加到运行环境或现有 `deno/.env`。模板中的凭证由部署机密提供。客户端模板仅在服务器已启用主控模式后生效；仅修改客户端模型名不会改变服务器的实际路由。

| 变量 | 默认／用途 |
|---|---|
| SIDER_CONTROLLER | `true` 启用独立主控模式；未设则维持现有路由 |
| SIDER_CONTROLLER_STORAGE | Deno 使用 `kv`，Bun 使用 `sqlite`；`memory` 仅用于隔离测试 |
| SIDER_CONTROLLER_KV_PATH | Deno 本地可指定 `.runtime` 内数据库；Deploy 留空连接关联的 Deno KV |
| SIDER_CONTROLLER_MAX_INPUT_CHARS | 默认 `14000`，限制实际单次新增输入；更长内容完整分段登记 |
| SIDER_CONTROLLER_PACE_MS | 默认 `12000`，上游流结束后的账号级间隔，来自本次成功探测节奏 |
| SIDER_REQUEST_TIMEOUT_MS | 默认 `300000`，Sider 上游真实字节的空闲期限 |
| SIDER_TOTAL_TIMEOUT_MS | 默认 `600000`，独立总期限；客户端 ping 不刷新它 |

Deno Deploy 必须关联可用的 Deno KV。主控状态存储失败会返回错误，不能静默降级为内存并丢失会话。Bun 使用运行目录的 `.runtime/controller.sqlite`，需要可写目录；多个本地进程可共享此数据库。

账号租约跨对应数据库的服务进程互斥，持有至上游处理及状态写入结束，并按 holder 校验释放。Deno KV 与 Bun SQLite 是不同存储；不能让两个部署分别使用这两个数据库却共用同一账号并发调用。

等待队列每进程最多 32 条、最多等待 30 秒；超过返回 429。任务与引用保留 24 小时，过期判断由记录时间完成，不能依赖数据库何时实际删除过期值。

## 模型与回退

主控模式要求使用模型目录中明确登记的名称。当前实际验证重点是 `claude-opus-5.5` 和 `claude-sonnet-5.5`，不会猜造 Opus 5.5 的 `-think` 别名，也不会静默改名为旧版 Opus。

两个模型已在未显式传入 thinking 参数时返回推理事件。不能把 Anthropic 的同名 thinking 参数或展示思考块的开关理解为已验证的 Sider 思考预算控制。

本期经过验证的工具链路直接由本地转换完成，**不会调用 GLM 重做业务回合**。GLM 参数猜测、重写正文以及会话接管没有作为主控模式的回退功能启用。现有兼容后端配置保留，关闭主控模式时可继续使用原有 GLM 路由。

Sider 额度耗尽按模型保存上游建议的恢复时间并返回 429，任务检查点保留。仅明确的建立连接失败允许一次有界重试；读取超时、SSE 业务失败及可能执行过服务端工具的请求不重试。

## 验证与边界

```powershell
npm.cmd run test:regression

# 原有13套集成回归，要求上游受限也导致非零退出码。
$env:E2E_REQUIRE_ALL_PASS='true'
deno run --allow-net --allow-env --allow-read --allow-write deno/test/integration/run.ts

# 新主控套件；两个地址应是启用了主控的独立进程且共享对应数据库。
$env:E2E_CONTROLLER='true'
$env:E2E_CONTROLLER_SECOND_URL='http://localhost:18002'
$env:E2E_TIMEOUT_MS='600000'
deno run --allow-net --allow-env --allow-read --allow-write deno/test/integration/run.ts 14

# 实际Claude Code客户端；使用已安装的claude，或通过CLAUDE_CODE_BIN指定可执行文件。
deno run --allow-net --allow-env --allow-read --allow-write=.runtime --allow-run deno/test/integration/claude-code-controller.ts
```

主控模式当前拒绝未证实可用的图片输入，不能假装 Sider 已看见图片。原生搜索是服务端工具，不能代替客户端 Read／Write／MCP；统一 `tool_call` 的协议解析已兼容，但主控工具循环默认不启用它，避免不可观察的服务端副作用。

上下文每次最多登记 16 个分段，正文单项最多 512,000 字符；超限保留检查点并返回明确错误。本次大上下文通过不代表无限记忆或最高吞吐。上游模型标识是 Sider 返回的标识，不能独立证明底层权重身份。

Sider 未提供真实 token 用量；报告和兼容 usage 采用字符估算，并汇总内部登记／保存／纠正轮次，不能当作真实计费或厂商思考预算。Deno 的调用遥测按上游尝试记录；Bun 保持现有遥测边界，另有请求完成统计及本地验证日志。

Bun服务端空闲期限明确设置为255秒，主控SSE每5秒发ping，避免已实测的默认10秒期限与10秒心跳竞争。ping仅维持客户端连接，不延长上游空闲或总期限。
