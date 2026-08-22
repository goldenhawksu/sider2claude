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
- 历史工具轮被转录成文本后，上游会把转录格式当成调用协议模仿，输出纯文本的
  「工具调用」。这会让响应退化成 `stop_reason: end_turn` 且无 `tool_use` 块，
  Claude Code 据此判定回合结束、**agent 循环提前停止**。因此：
  1. `parseTextualToolUseLine` 必须认识**当前 sanitize 实际产出的每一种格式**
     （`Previous assistant tool request:` 与 `[tool_use:Name]`）。改转录格式时
     必须同步改这个解析器，否则兜底网会对着自己的输出漏掉。
  2. 还原出 `tool_use` 后，`stop_reason` 必须由 `end_turn` 改判为 `tool_use`。
  3. 还原带 guard：行内 id 若已出现在本次请求历史的 `tool_use.id` /
     `tool_result.tool_use_id` 中，说明模型在复述历史而非发起新调用，保持文本
     不还原——否则 `Bash`/`Write` 这类写操作会被重复执行一次。
  4. 防模仿提示词（`applyToolProtocolInstruction`）点名的格式必须与上下文里
     真实出现的转录格式一致，否则等于没禁。

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

## 用量统计

`GET /` 的响应里带 `usage` 字段，回答"最近的调用由谁完成、比例多少、工具用了多少"：

- `totals`：真实上游调用数、sider/deepseek 各自次数、fallback 次数、流式次数、
  工具调用次数，以及 `cachedReplays`（命中重复响应缓存、未触达上游的请求，
  单列以解释"发了 N 次为何统计只有 M 次"）。
- `backendShare`：后端占比；`lastHour`：最近 1 小时同口径聚合。
- `tools`：工具调用频次 Top 8；`recent`：最近 10 条明细（时间/模型/后端/
  是否 fallback/工具/是否流式/耗时）。

- `trend`：近 24 小时按小时分桶（空桶保留，时间轴连续）。**趋势由独立的
  按桶累计维护（`trendBuckets`），绝不能改回遍历 `recent`**——`recent` 有
  200 条上限，用它算趋势会让早期桶被静默截断，且失真是单向的（越早掉得
  越狠），图会长成"什么都刚刚发生"的假曲棍球棒，形状比绝对值先坏掉。
  桶按 24 小时窗口淘汰；`models`：按模型聚合的
  请求数与 token 数，并按**归因**拆出该模型走 DeepSeek 的三个来源。
- **DeepSeek 归因**（`deepseekTools` / `deepseekFallback` / `deepseekRouting`）回答
  「某模型这一轮到底 fallback 了多少次 DeepSeek」：
  - `tools`：ruleId ∈ {`rule_1_tool_result_continuity`, `rule_2_claude_tools`,
    `rule_3_mcp_tools`}，请求带 Claude Code / MCP 工具，本就该由 DeepSeek 承接；
  - `fallback`：实际后端 ≠ 路由初判，即 Sider 调用失败后被迫兜底——**只有这一类
    说明 Sider 配额/可用性出了问题**；
  - `routing`：其余主动选择 DeepSeek 的规则（长文本、默认后端）。
  判定在 `classifyDeepSeekReason()`（放统计模块，因为这是观测语义而非路由语义），
  埋点处把 `(selectedBackend, decision.backend, decision.ruleId)` 传进去。
  不变式：三个分项之和恒等于 `deepseek`，按模型与按总量都成立，测试守住。
  新增路由规则时若它把请求判给 DeepSeek，必须决定归入 `tools` 还是 `routing`
  （不加就默认落进 `routing`）。
- `GET /stats` 渲染自包含的 HTML 看板（内联 SVG+CSS，无外部依赖）：环形图
  （模型分布）+ 面积图（token 趋势）+ 表格 + 后端堆叠条，浅色/深色随系统。
  `GET /stats.json` 返回同一份快照的原始 JSON。
- 模型表有一列「走 DeepSeek」按归因展示（零值不渲染成 0，用 `—` 占位），
  受限兜底单独着色（`.warn-num`）——它是唯一需要用户采取行动的分项。
- 配色取 dataviz 参考调色板前三个分类槽位（浅深两套已过 validate_palette），
  模型超过 8 个折叠为「其他」，绝不循环取色；模型名/工具名经 HTML 转义。
- 页面所有时间戳按固定 **UTC+8**（北京/上海）渲染，页头标注时区。
  绝不能用 `Date#getHours()` / `getMinutes()` —— 那读运行时本地时区，
  Deno Deploy 进程时区是 UTC，页面会晚 8 小时。用
  `new Date(ts + DISPLAY_TZ_OFFSET_MS)` 配 `getUTCHours()` 换算。
  注意：开发机若本身在 UTC+8，`getHours()` 会碰巧正确，本地测不出问题，
  因此 `deno/test/stats-page.test.ts` 里有一例通过替换全局 `Date`
  模拟 UTC 运行时来守这条线，改时间渲染时不要删。
- 页面每 5 秒自动刷新，**局部替换而非整页重载**：内联脚本重新 GET `/stats`，
  用 `DOMParser` 解析后按 8 个区域 id 逐个比对 `innerHTML`，
  **相同就不写 DOM**（写入即重绘，这是不抖动的关键）。
  不用 `<meta http-equiv="refresh">`（闪白、滚动归零）；也不改成客户端读
  `/stats.json` 自行渲染（donut/trendChart 逻辑会变成两份，必然漂移）。
  另有并发保护（`inFlight`）、页面不可见时暂停、失败静默重试。
  新增可变区域时必须同时加 `id` 并登记进脚本的 `REGIONS`，
  否则该区域永远不刷新；已有测试断言两者数量与对应关系一致。

实现在 `src/utils/usage-stats.ts` 与 `deno/src/utils/usage-stats.ts`（双侧一致，
`stats-page.ts` 同）。
埋点在请求完成处：Deno 侧非流式与**三条**流式路径各埋一次（Sider 真流式、
DeepSeek 合成流式、DeepSeek 无工具真流式）；Node 侧流式是 buffered 模式
（先走完非流式再转 SSE），因此只在非流式完成点埋一次、用请求自身的 stream
标志区分，避免双计。
DeepSeek 无工具真流式拿不到汇总响应，token 从 SSE 事件里捡：`input_tokens`
在 `message_start`、`output_tokens` 在 `message_delta`。

持久化（解决"打开 /stats 看到全 0"）：Deno Deploy 会拉起多个隔离实例并
回收空闲实例，纯进程内统计在生产上几乎必然让用户命中空实例。**全部统计**
（总量/模型/趋势/工具频次 + `recent` 明细 + `lastHour` 窗口）由
`deno/src/utils/usage-stats-kv.ts` 写入 Deno KV，两种存储形态：

1. 聚合计数走 `['stats', ...]` 下的 sum mutation——无竞争、原子累加，
   每请求的全部增量编码成一次 atomic commit，fire-and-forget 不阻塞响应。
2. 明细与滑动窗口走**单个** `['live']` key，存 `{recent, minutes}`，
   用 check-versionstamp 的 CAS 更新。不用"一条明细一个 key"是因为
   `/stats` 每 5 秒自动刷新，那样每次刷新都要 list 几百个 key；
   定长数组塞一个 key，读取恒为 1 次 get。
   - `recent` 定长 20 条（看板展示 10 条），写入时截断；
   - `lastHour` 由 60 个分钟桶求和得到，保住**真滑动窗口**语义
     （若改用小时桶，10:05 时"最近 1 小时"只有 5 分钟数据，是降级）；
     窗口相对**读取时刻**计算，服务闲置一小时后残留的旧桶不再计入。

**`['live']` 的 CAS 更新必须同实例内串行化**（`enqueueLive` 的 promise
队列）。`persistUsage` 是 fire-and-forget，并发请求会同时读到同一个
versionstamp 争抢同一次提交，只有一个能赢——实测未串行化时并发写 30 条
只活下来 4 条。串行后同实例零竞争，跨实例竞争交给 `updateLive` 的 3 次重试。
队列有深度上限（64），极端流量下宁可丢观测数据也不让待处理写无限堆积。
`deno/test/usage-stats-kv.test.ts` 有并发回归测试守这条线。

**不要用 `expireIn` 做过期**：实测 `:memory:` KV 上写多久都不生效
（Deno 2.5.4），本地测不出来的行为不能作为正确性依赖。回收是确定性的：
`recent`/`minutes` 在写入时按长度和窗口裁剪；趋势旧桶（>25 小时）在
`collect()` 扫描时顺手删——趋势 key 永不覆盖写，不回收会无限堆积，
而 `/stats` 每 5 秒全扫一次，堆积直接变成刷新开销。

`STATS_KV` 环境变量控制模式：未设 = 完全跳过 KV（零开销
降级，其余测试不受影响）；`memory` = :memory: KV 走全链路（测试用）；
`kv` = 默认 openKv()（Deploy 上连平台数据库，本地会落文件）。

KV 仍属 unstable API：类型靠文件顶部的 `/// <reference lib="deno.unstable" />`，
运行时需要 `--unstable-kv`（deno.json 的 dev/start/test/regression 已加；
Deploy 平台默认开放）。`usage-stats-kv.ts` 仅 Deno 侧存在，Node/Bun 运行时
无 Deno KV——`src/utils/usage-stats.ts` 的 `getStatsSnapshot()` 恒返回进程内
快照，两侧调用方代码保持一致。

启用生产持久化的平台步骤（代码无法替代）：Deno Deploy 后台 Databases 里
Provision 一个 Deno KV 数据库并关联本应用，再在应用环境变量里加
`STATS_KV=kv`。未配置时自动降级，页脚会显示"未持久化"警示。

约束：

- `recent` 只记白名单字段，不得混入消息内容、token 或请求参数。
- 回放请求不计入 `requests` 与占比，否则会稀释"由谁完成"的真实比例。
- KV 写失败必须静默（进程内统计仍在），KV 读带 2s 超时并回退进程内——
  统计永远不能拖垮或阻塞请求。
- 归因字段必须同时写进 KV（`usage-stats-kv.ts` 的 `REASON_FIELD` 与
  `MODEL_FIELDS`）。生产上 `/stats` 的聚合读的是 KV，只留进程内的话
  用户看到的三个分项永远是 0。
- 趋势必须由 `trendBuckets` 而非 `recent` 计算（见上文，形状会失真）。
- `['live']` 的写入必须经 `enqueueLive` 串行，绕过它直接 CAS 会丢明细。

## 测试策略

确定性测试（mock 上游，`deno task test`）：

- `deno/test/hybrid-routing.test.ts`
- `deno/test/deepseek-adapter.test.ts`
- `deno/test/sider-upstream-error.test.ts`
- `deno/test/duplicate-cache-isolation.test.ts`
- `deno/test/messages-hybrid-stream.test.ts`
- `deno/test/usage-attribution.test.ts`

重点覆盖：

- DeepSeek 原生 `tool_use` 能力补齐。
- DeepSeek 响应侧 `thinking` / `redacted_thinking` 透传。
- Claude Code 工具续轮历史转录，避免 DeepSeek `content[].thinking` passback 400。
- 文本工具调用兜底：两种转录格式都能还原成 `tool_use` 且 `stop_reason` 改判，
  复述历史 id 不还原，普通文本不误判。
- Sider 的 SSE 内业务错误码（如 1135 用量超限）必须上抛，不能吞成空回复。
- 带工具的 `tool_result` 续轮不得被会话延续规则路由回 Sider。
- 重复响应缓存按流式隔离，流式响应不得被等价非流式请求回放。
- DeepSeek 归因：带工具的请求记 `tools` 而非 `fallback`；Sider 受限兜底记
  `fallback`；DeepSeek 无工具真流式必须被计入统计（历史上漏埋）。

Node/Bun 侧适配器单元测试（mock fetch，不需要起服务）：

- `test/deepseek-adapter.unit.test.ts`，由 `npm run test:unit:node` 单跑，
  已并入 `npm run test:regression`。与 `deno/test/deepseek-adapter.test.ts`
  对应，保证双运行时的适配器行为同步。

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
