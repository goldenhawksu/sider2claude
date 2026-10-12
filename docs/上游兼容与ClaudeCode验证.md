# GLM、DeepSeek 与 Claude Code 客户端兼容

## 结论与范围

当前接口与用户操作分别见 [API 参考](API参考.md) 和[用户使用指南](用户使用指南.md)。
本文保留上游实测依据；Deno／Bun 的主控流式开关、输入上限及存储差异以[主控说明](Sider主控模式.md)为准。

采用统一客户端输出规范，加上既有的上游响应自适应机制。不要按模型名称决定
是否透传服务端工具，也不要将服务端工具改成 MCP／本地工具调用。

2026-10-07 当前实时验证入口是 `api.z.ai` 的 `glm-5.3-flash`。
DeepSeek 对照来自项目此前官方入口的 `deepseek-v4-flash`／`deepseek-v4-flash-vision-exp`
实测记录和确定性重放；这些记录不能证明其他名为 `deepseek-flash` 的入口行为完全相同。

2026-10-12 根据生产 ppt-master 运行记录补测：Claude Code 会为长上下文请求使用
`claude-sonnet-5.5[1m]` 形式的模型名。代理现仅在查找上游时剥离末尾 `[1m]`／`[200k]`
数字窗口标签，主控与普通路由统一映射到基础模型；对外响应仍保留客户端原始名称。

同日补修 cc-switch 的 1M 开关场景：Sider 最终发送边界也规范化 `model` 和 `chat_models`，
检查点、历史、重放和两种限流状态不再把带标签与无标签名称当作不同模型。
Claude Code 2.1.291 的 auto 分类使用 XML `<block>`／`<severity>` 协议；真实 Sider
拒答复现后，明确的无工具 XML 分类统一选择配置的原生兼容后端，不受主控抢占或
业务会话后端记忆影响。显式 `thinking: disabled` 在 JSON 和流式路径都被兑现，
避免小预算分类被上游推理占满。模型判定和失败直接交回客户端，不伪造允许结果。

同轮还确认 Z.ai 内置 `webReader` 对含中文路径的 GitHub URL（包括百分号编码 raw URL）
可能返回 MCP -400。真实 raw SSE 证明：声明客户端 `webReader`／`WebFetch` 工具时，
条件 system 指令可直接得到客户端 `tool_use`，避开两次无效的内置工具尝试。因此该提示
只对网页工具集合注入；普通 Read／Write／Bash 的稳定提示前缀不变。

## 行为依据

| 项目 | GLM 当前探测／既有实测 | DeepSeek 官方入口既有实测 | 代理处理 |
|---|---|---|---|
| MCP 工具 | 当前 auto、强制指定均返回标准 `tool_use` | 支持标准工具调用；thinking 下强制指定曾返回 400 | 保留工具名、ID、参数；强制指定继续沿用已有文本意图兼容 |
| 服务端搜索 | 当前实际出现 `server_tool_use`、通用 `tool_result`，同轮可有多个调用 | 当前未重新验证原生搜索能力 | 输出转换按内容类型处理，不按厂商猜测 |
| 网页读取 | 内置 `webReader` 对中文 GitHub 路径可返回 -400；声明客户端网页工具后可直接返回其 `tool_use` | 未重新验证 | 有客户端网页工具时提示优先客户端执行，不重写 URL 或伪造结果 |
| thinking 预算 | 历史 64／256 token 曾只产出 thinking | 历史 64 失败、256 已有正文 | 显式 disabled 首次兑现；否则按 `baseUrl::model` 学习，在符合判据时关闭 thinking 重试一次 |
| 历史工具块 | 工具循环可用，历史参数兼容程度较宽 | thinking passback 校验更严格 | 保留既有历史文本转录与图片透传策略 |
| `tool_choice: none` | 历史观察到忽略参数 | 历史观察到原生生效 | 隐藏客户端工具，避免仅靠参数导致意外调用 |
| stop 序列 | 历史观察到截 thinking、结束原因不准确 | 历史观察到符合规范 | 保留既有正文层截断，不能截断工具结果记录 |

## 输出契约

对外内容块限定为 `text`、`thinking`、`redacted_thinking`、`tool_use`：

- `server_tool_use` 转为文本调用记录，保留原始调用字段。
- 搜索、抓取、代码执行专用结果和通用 `tool_result` 转为文本结果记录，
  保留关联 ID、结果内容、来源网址和错误，不任意截断或丢弃。
- 真正的客户端 `tool_use` 原样保留，不执行、不重命名，不重复生成调用。
- 服务端结果里的工具转录文本不送进工具调用还原器，避免把网页内容变成可执行调用。
- `tool_use` 结束原因仅在存在实际客户端调用时要求客户端继续；
  只有已完成服务端工具结果时，错误的 `tool_use` 结束原因转为 `end_turn`。
  `max_tokens` 与 stop 序列等结束原因保持既有语义。

统一转换在 `utils/client-content.ts`，两套运行时保持相同实现。
JSON 响应在原始块校验、工具还原和 stop 序列处理之后转换。
Deno 真流式只缓冲服务端工具的输入 JSON 片段，在块闭合时转换为文本；
其余正文、thinking 和客户端工具仍按增量发送。每个请求单独维护状态。
畸形或不完整的服务端输入明确报错，并通过 finally 取消上游 reader。

可观察日志 `server_tool_content_normalized` 只记录转换类型、provider 和请求标识，
不记录工具输入、结果正文或凭证。完整结果转文本会增加客户端可见正文长度，
但不会增加一次上游请求；这比静默丢失来源或重复执行工具更符合用户任务语义。

## 验证方法

Write 参数完整性补修：实测宽松引号修补会把正文内部 `file_path` 或 `content`
当成外层工具字段，导致路径覆盖和正文丢失。Write 文本调用现只允许严格 JSON，
并与结构化 Write 一同验证 file_path 为非空字符串、content 为字符串；
Windows 路径不能含非法控制字符。坏参数阻止下发并返回明确的上游响应错误，
不自动重试或猜测修补。合法参数逐字保留，包括长 JSON、中文、换行和反斜杠。
该保护不能替模型判断合法字符串内的业务内容是否正确；写入 JSON 文件后仍需
应用执行 JSON/schema 校验。模型自述“基础设施故障”不是网络损坏的证据。
套件 13 验证实际 GLM 输出的 Windows 目标路径，以及 12 项 manifest 的全部字段和值；
JSON 末尾换行不算业务数据损坏。参数传输的逐字一致由确定性测试及真实客户端文件复制验证。

2026-10-07 补充长请求修复：原来的带工具请求把上游设为非流式，并用从请求开始
计时的 90 秒固定上限等待完整响应，51 消息、18 工具的生产请求因此被中断。
现在两套运行时都向上游请求 SSE，按事件拼接正文、thinking、工具输入和 usage，
仍然在完整工具输入校验后才向客户端合成输出，兼容服务端工具转换和文本工具还原。
也接受返回 JSON 的兼容端。默认连续空闲上限为 5 分钟，每轮总上限为 10 分钟；
已有 `DEEPSEEK_REQUEST_TIMEOUT_MS` 覆盖值沿用为**空闲上限**，不是整轮总时长。
收到真实上游字节会刷新空闲计时，代理自己的客户端心跳不会刷新它。
新日志记录首个上游字节、空闲／总时长超时类别和最近活动时间，不记录响应正文。
此修复不会截断历史或降低 token 预算；上游真实停滞或达到总时长上限仍明确报错，
不会为了“通过测试”隐藏错误，也不自动重试可能已经执行的工具。

`deno/test/upstream-timeout.test.ts` 与 `test/upstream-timeout.unit.test.ts` 缩短测试时钟，
验证持续生成超过超时窗口仍成功、卡住的正文返回 503、总上限不可被心跳绕过、
输入和 usage 正确重建，以及提前结束的流不能冒充成功。集成套件 12 实际发送
51 条消息和 18 个工具；它不等于完整复刻用户未提供的生产历史内容。

1. 确定性测试模拟 GLM 的服务端工具块和 DeepSeek 的标准工具响应，
   检查 JSON、合成流、真流式、通用／专用结果、错误、来源、结束原因、
   缓存 token 计数、工具结果中的伪调用文本以及并发请求隔离。
2. 所有集成测试的消息和 SSE 内容块都执行客户端类型检查，
   不再仅以 HTTP 200 或 `message_stop` 判断兼容。
3. 新套件 11 使用真实上游验证搜索来源保留，以及 17 工具请求中的
   README 抓取失败 → webReader → Write 文档循环。工具执行结果由测试模拟，
   不宣称运行了完整 ppt-master 或 VS Code 界面。
4. 本机真实 Claude Code 2.1.195 验证了：捕获的 GLM 原生搜索响应经代理转换后
   正常显示来源并结束；真实 GLM 经代理执行 Read → Write，实际生成文档，
   文件中保留了指定版本、安装与启动信息。
   CLI 测试使用隔离目录、独立 `CLAUDE_CONFIG_DIR`、`--setting-sources ""` 和
   safe-mode，排除个人 provider 与工具权限设置对测试地址的覆盖。
   本地转发日志确认客户端发送了 Read、Write 并实际访问本次代理；
   先移除旧的测试输出，再以新文件内容为验收依据，不能把退出码 0 当成任务完成。
5. `deno/tools/probe-server-tool-continuation.ts` 可分别观察 raw SSE 和 adapter 归一化结果。
   2026-10-12 实测 raw 响应先出现两个失败的 `server_tool_use:webReader`，随后产生
   `tool_use:mcp__webReader__read`；adapter 输出保持 `tool_use` 和客户端工具名。
   加入优先客户端网页工具提示后，raw 响应不再出现服务端工具块，直接请求客户端 MCP。

```bash
npm run test:regression
deno check deno/test/integration/run.ts
deno task test:e2e
npm run test:integration
git diff --check
```

推送条件是全部集成用例通过，失败和上游受限均为 0。实际 VS Code 插件版本
未在此环境直接操作；Claude Code CLI 消费验证补充协议测试，不能代替全部 UI 行为测试。
