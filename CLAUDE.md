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
2. dotenv 文件兜底：**`deno/.env` 是唯一配置源**，找不到才回退仓库根 `.env`（旧布局兼容）。
   两个运行时与集成测试（`deno/test/integration/config.ts`）走同一优先级——三者必须一致，
   否则测试会拿着不匹配的 `AUTH_TOKEN` 打出一片 401。
3. 调用方默认值最后。

注意第 2 条的一个陷阱：`withEnv` 之类只能删**环境变量**，删不掉 dotenv 里的值。
所以「把某个变量设为 undefined 来验证代码默认值」是错的——那只会落到 dotenv。
测试要验证默认值就显式传该值，不要依赖「本地 dotenv 恰好等于默认值」。

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

# 超过此体量的请求不投 Sider（实测 44K 字符会被 code 603 硬拒）
# 仅 SIDER_STRATEGY=conservative 时生效
SIDER_MAX_INPUT_CHARS=30000

# Sider 投递策略三档：conservative（默认，静态阈值+固定冷却）/ pro（自适应碰撞，纯对话）/ max（pro 基础上工具也投 Sider）
# aggressive 是 pro 的旧名，仍被兼容解析为 pro。也可在 /stats 页面随时切换（存 KV，跨实例）
SIDER_STRATEGY=conservative
```

工具能力兜底上游统一走 `DEEPSEEK_*` 一套配置，**没有 `ANTHROPIC_BASE_URL` /
`ANTHROPIC_API_KEY` 这两个环境变量**（历史上曾作为兼容别名，已移除）。
`DEEPSEEK_BASE_URL` 可指向任意 Anthropic 兼容端：要用 Z.AI 的 GLM-5.3，只需把
`DEEPSEEK_BASE_URL` 改成 Z.AI 的 Anthropic 兼容入口、`DEEPSEEK_API_KEY` 改成 Z.AI 的 key、
`DEEPSEEK_MODEL` 改成 GLM-5.3 的模型名，其余不用动。

`DEFAULT_BACKEND=anthropic` 仍兼容为 `deepseek`（那是路由后端名，不是上游配置变量）。

不要把 Claude Code 客户端连到本服务用的 `ANTHROPIC_BASE_URL=http://localhost:4141`
当作服务端的 DeepSeek 上游配置——那是客户端视角的变量，服务端只认 `DEEPSEEK_*`。

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
- `src/utils/sider-throttle.ts` / `deno/src/utils/sider-throttle.ts`（pro/max 的自适应限流）
- `src/utils/textual-tool-use.ts` / `deno/src/utils/textual-tool-use.ts`（文本工具调用还原，Sider 与 DeepSeek 共用）
- `src/utils/runtime-strategy.ts` / `deno/src/utils/runtime-strategy.ts`（运行时策略切换）
- `deno/src/utils/sider-telemetry.ts`（运行遥测，仅 Deno 侧）
- `src/utils/sider-availability.ts` / `deno/src/utils/sider-availability.ts`（保守策略的固定冷却）

## 路由原则

- **成本前提**：Sider 是包年订阅（边际成本 0），DeepSeek 按量付费。因此策略是
  「能用 Sider 完成的就不要用 DeepSeek，DeepSeek 只做能力补齐与兜底」。
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
- **Sider 有两道硬约束，路由必须提前避让**（数字均来自实测，见「Sider Probe」一节）：
  1. 单请求体量：约 32,000 字符通过、44,000 字符被 `code 603: Too many words in
     the query` 硬拒。
  2. 用量额度**按模型分开**：超出返回 `code 1135`。实测同一时刻 sonnet-5 可用而
     opus-4.8 已耗尽，因此熔断必须按模型隔离，一刀切会误伤还有额度的模型。
  这两道门只影响「要不要**主动选** Sider」，不改变既有 fallback —— Sider 真失败
  时该兜底还是兜底。入口统一在 `RouterEngine.siderUsable()`。
- **三档投递策略，由 `SIDER_STRATEGY` 选择**（也可在 `/stats` 页面随时切换）：
  - `conservative`（默认）：静态 `SIDER_MAX_INPUT_CHARS` 门 + 固定两档冷却熔断，
    实现在 `utils/sider-availability.ts`。冷却依据实测额度窗口：**opus 档 1 小时**
    （单窗口仅 2~3 次，等 200 秒仍未恢复，属小时/天级），**其余 60 秒**
    （约 6 次/分钟，与上游提示 "try again after 1 minutes" 一致）。
  - `pro`：三道门全部交给 `utils/sider-throttle.ts` 的自适应限流器，阈值由运行中的
    603 / 1135 反馈碰撞学习。纯对话优先 Sider，工具请求仍全部给 DeepSeek。
  - `max`：在 `pro` 基础上，**工具调用也先投 Sider**（靠往 prompt 注入文本工具契约，
    见下「Max 策略」），失败再 fallback DeepSeek。
  只有 `code 1135` 该**立即**触发熔断——把每个错误码都当额度问题，会把偶发抖动
  放大成长时间不可用。但「不立即熔断」不等于「什么都不学」，实测另有两类失败：
  - **`1101` 并发受限**：Sider 同一时刻只接一个 active request。遥测实测 13 次
    1101 全落在两簇里，中位相邻间隔 **6 毫秒**、92% 的间隔 <2 秒，每簇恰好一个
    请求成功。这类走 `recordSiderConcurrencyLimit`，**只乘性降速、绝不停投**——
    一次 10 并发会瞬间产生 9 次连续 1101，走停投通道的话第 3 次就把一个完全健康
    的模型停投 5 分钟。降速才是对症的：令牌少了，能同时挤进来的请求就少。
    `deno/test/sider-throttle.test.ts` 里「并发簇只降速」是关键回归，别删。
  - **`707` 等持久性拒绝**：某模型在 Sider 侧根本接不了（`claude-fable-5` 恒返回
    707，三次复现无一成功），与时机、载荷都无关，上面几个维度学不到任何东西，
    于是每个请求都白撞一次 Sider 再 fallback。这类由 `recordSiderRejection` 兜住，
    判据保守到三条闸：只认明确的业务错误码（`siderCode ≠ 0`，网络抖动/超时不算）、
    要连续 3 次（任一次成功即清零）、停投可恢复（复用 1135 的 half-open 探测，
    退避从 5 分钟起）。改这里时不要把「一次成功即清零」去掉——没有它，跨越很长
    时间的孤立故障会攒够 3 次，把偶发放大成停投，正是这条通道要避免的事。

  一句话区分：**1135/603/1101 都假设「换个时机或换个载荷就能成功」，只有 707
  这类是「这个模型现在压根接不了」**。把 1101 错分进后者是真实发生过的回归。
- **策略是运行时可变的**：`utils/runtime-strategy.ts`（Deno 侧存 KV 跨实例收敛、
  Node 侧存进程内存）。`config.routing.siderStrategy` 被包成 getter，优先读运行时
  覆盖、其次读环境变量。读点（路由、契约注入、统计）无需感知这个差异。
  **统计/看板这类不该触发完整配置加载的路径**用 `currentEffectiveSiderStrategy()`，
  不要在这里调 `loadBackendConfig()`——那在无 token 的环境（如测试）会抛错。
- **Max 策略的工具链路**：Sider 的 `tools` 字段对 Claude Code 工具是死路
  （`buildSafeToolsConfig` 只保留 Sider 原生工具），所以契约必须拼进 `multi_content[0].text`。
  契约原文来自 `probe-sider-tool-loop.ts` 的 `contract()`，一字未改（改了就要重跑
  probe 的 5/5 套件）；格式 `[tool_use:X] id=Y input={...}` 与历史转录、解析器三者同构。
  `parseTextualToolUseLine` 已提成共享模块 `utils/textual-tool-use.ts`，Sider 与 DeepSeek
  通道共用。响应侧 `convertSiderToAnthropic` 跑还原，还原出 `tool_use` 后 `stop_reason`
  必须改判 `tool_use`（否则 agent 循环停住）。
- **Max 的还原失败判据是「形状像调用却解析不出」**（`TEXTUAL_TOOL_LINE_SHAPE` 命中但
  `unparsedCount > 0`），**不是「没有 tool_use」**——契约明确允许模型不需要工具时直接
  作答，probe 实测 5/5。把后者判成失败会把正常回答也兜底掉。`SiderToolRestoreError`
  上抛触发 fallback。Max 下的工具请求走 **Sider 合成流**（先非流式收完、还原、再切 SSE），
  真流式逐 delta 直发会把调用行当正文吐出去，来不及还原。
- **为什么要有 `pro` / `max`**：保守策略把 Sider 从「先试试，不行再兜底」变成了
  「永远不试」。静态 30K 门对 Claude Code **恒成立**（每轮重发完整 system prompt +
  CLAUDE.md + 全历史），实测 Sider 占比只剩 6%，且 fallback 计数为 0 —— 后者是
  决定性证据：不是试了失败，是根本没试。而 Sider 是包年订阅、额度**持续回血**，
  「一次 1135 锁死一小时」等于把白撞一次的代价换成浪费整个窗口的额度。
- 自适应限流器按模型维护三个独立收敛的维度，思路取自 TCP 拥塞控制的 AIMD：
  1. **频次**：令牌桶。1135 -> 乘性降速（×0.6）并清空令牌；连续 8 次成功 ->
     加性升速（×1.2）。速率会在上游真实容量附近微振荡，这就是「动态碰撞」。
     令牌不足时**不投 Sider 也不算失败**，直接走 DeepSeek。
  2. **体量**：603 是最硬的实测证据，直接把上限降到失败载荷的 85%，不必等多次
     采样；只有载荷已达上限 90% 却仍成功，才敢上探（×1.1）。喂进去的必须是
     **实际发给 Sider 的载荷长度**（`multi_content[0].text.length`），不是
     `inputCharCount` —— 后者含 system 与全历史，与真正投出去的东西不是一回事。
  3. **配额耗尽**：只有速率已降到底仍连续 3 次 1135 才短暂停投，退避从 30 秒起
     指数翻倍（opus 封顶 1 小时、其余 5 分钟），到期用 **half-open 放行一个探测**
     自己摸出恢复时刻。探测成功即解除并重置退避。
- 限流器的**检查与消耗必须分开**（`canUseSider` 只读 / `consumeSiderSlot` 扣费）。
  `applyRoutingRules` 在规则匹配的最开始就要判定 Sider 可用性，但那一刻还不知道
  工具规则会不会把决策覆盖成 DeepSeek。若检查即扣费，每个走 DeepSeek 的工具请求
  都会白扣一次 Sider 额度，纯对话就没得用了。扣费只在 `decide()` 拿到最终决策
  且后端为 sider 时发生。测试守着这条线。
- 长文本判据（`detectLongFormSignals`）**只看最后一条 user 消息**，不看历史、
  不看 assistant 回复、不看 `tool_result` 内容。曾经扫描整段对话，导致
  「对话越长越必然误判」：判据是「出现创作动词 且 出现长文体裁词」，而任何一段
  像样的编码对话里这两类词都必然出现，实测最后一轮只说「请继续」也会被判成
  长文生成而路由去 DeepSeek。改这里时不要把输入换回全文。
- Sider 用 `HTTP 200 + SSE 内 code != 0` 表达业务失败（如 1135 用量超限）。
  这类失败必须转成 `SiderUpstreamError` 上抛（1135 -> 429，其余 -> 502），
  非流式据此触发 fallback。
  判定保守：仅当收到非 0 code 且完全没拿到文本时才判失败。
- **流式的 Sider 失败会先尝试无感切到 DeepSeek**，切不了才发 Anthropic `error`
  事件。窗口判据是「一个内容块都还没开过」（`currentBlock === null &&
  blockIndex === -1`）：那时客户端只收到过 `message_start`，而该事件不带任何后端
  烙印（id 本地生成、model 是客户端请求的模型名），因此改由 DeepSeek 续吐在协议
  上不可区分。已经吐过内容就没有回退空间——半路切换会让文本断裂或重复，只能报错。
  这层兜底是激进投递的**前置安全网**：主动碰撞额度上限意味着失败变多，没有它，
  「优先投 Sider」等于「让用户天天看到失败」。受全局 `AUTO_FALLBACK` 控制，
  不受规则级 `allowFallback` 影响（那个标志是为非流式的「重发一次」设计的）。
- 协议层（OpenAI / Gemini）的流式映射必须透传 Anthropic `error` 事件，
  否则上游失败时客户端只会收到空流 + `[DONE]`。
- 重复响应缓存只服务非流式路径。请求指纹刻意忽略 `stream` 字段（用于跨
  流式/非流式识别客户端重试的观测语义），因此缓存键必须额外带流式标记，
  不能让非流式请求回放流式响应。
- DeepSeek adapter 需要兼容 `text`、`thinking`、`redacted_thinking`、`tool_use`，真实上游可能在工具请求前返回推理块。
- **上游三处不符合 Anthropic 规范的行为，一律在本服务层兜住**（probe 脚本见
  `deno/tools/probe-deepseek-tool-choice.ts`、`probe-upstream-stop-sequences.ts`、
  `probe-upstream-max-tokens.ts`；改这三处前先重跑对应 probe）：
  1. **`tool_choice` 被完全忽略**：no/auto/any/tool/none 五种形态返回一模一样的
     `tool_use`。所以 `none` 只能靠**不发 tools** 兑现（`suppressTools`），
     透传和注入文本指令都拦不住它；同时响应侧要跳过文本工具调用还原，
     否则等于替上游把禁令推翻。代价是这一轮缓存前缀会变，属 `none` 语义的必要开销。
  2. **`stop_sequences` 截断作用在 thinking 上**，推理里撞到序列就整个停下，
     返回 `content=[thinking]`、正文 0 字；命中还报 `stop_reason:"end_turn"`。
     因此**不发给上游**，改由 `utils/stop-sequences.ts` 在正文 text 块上截断，
     Sider 与 DeepSeek 两条通道共用同一份实现（Sider 端压根不支持）。
     只作用于 text：thinking 是内部推理、`tool_use` 是结构化调用，都不该被切。
  3. **thinking 与正文共享 `max_tokens`**：小预算下推理吃光配额，返回
     「HTTP 200 + `stop_reason:max_tokens` + 正文 0 字」。`thinking:{type:'disabled'}`
     是唯一实测有效的开关（`budget_tokens`、`reasoning.enabled` 都被忽略）。
     但这一条**不能硬编码**——见下面「上游能力自适应」。

### 上游能力自适应

`DEEPSEEK_BASE_URL` 可以指向任意 Anthropic 兼容端：今天是 Z.AI 的
`glm-5.3-flash`，明天可能换回 DeepSeek 官方的 `deepseek-v4-flash`。
**两家行为并不一致**，且 CLAUDE.md 里的历史记录已经吃过一次亏：早先记着
「DeepSeek 对 `tool_choice:{type:'tool'}` 会 400」，换成 GLM 后实测不再 400。
所以上游差异一律**从响应里学**，不按 provider 名字猜、也不要用户配开关。

实现在 `utils/upstream-capabilities.ts`，目前只学一件事：这个上游会不会让
thinking 吃光小预算。

- **判据**：`stop_reason === 'max_tokens'` 且有 thinking 块且正文为空。三者缺一
  不可——有正文说明预算够用（那是规范的截断），没 thinking 则是普通输出截断。
- **首次撞上自动重试**：立刻带 `thinking:{type:'disabled'}` 重发一次，把正常内容
  交给调用方。那个空响应本来就是废的，重试是净收益，调用方对这次修正无感。
- **学到之后不再撞**：同一 `baseUrl::model` 的后续小预算请求直接注入，无额外往返。
  阈值由**实测失败点 × 2** 推出，不写死魔数；失败点只增不减，避免抖动。
- **上游拒绝 `disabled` 时降级**：记成终态并返回原响应。继续发只会把每个小预算
  请求都变成 400，比拿到空响应更糟。

**实测差异对照**（2026-08，本地 DeepSeek 官方 vs 线上 Z.AI，同一套代码只差上游）：

| 能力 | `glm-5.3-flash` | `deepseek-v4-flash-vision-exp` |
|---|---|---|
| `tool_choice: {type:'tool'}` | HTTP 200 | **HTTP 400**「Thinking mode does not support this tool_choice」 |
| `tool_choice: none` | 忽略，仍调工具 | 原生生效 |
| `stop_sequences` | 截 thinking、报 `end_turn` | **完全符合规范** |
| thinking 吃预算的阈值 | 256 仍失败，1024 才正常 | 64 失败，**256 已正常** |
| `thinking:{type:'disabled'}` | 有效 | 有效 |
| `budget_tokens` / `reasoning.enabled` | 忽略 | 忽略 |
| 图片校验 | 宽容 | 严格（边缘 PNG 会 400） |

这张表是「不能硬编码」最直接的证据：**没有任何一家的行为可以代表另一家**。
注意第 4 行——若沿用早先硬编码的 1024 阈值，DeepSeek 在 256~1024 区间会被无谓
关掉 thinking；而能力学习让两家各自收敛到自己的水位。

`deno/tools/ab-compare-upstreams.ts` 是这张表的可执行版本：换上游或改动兼容层
之后跑一遍，确认两侧不仅各自正确、而且**彼此一致**。

抹不平的差异必须说清楚：上游 4xx/5xx 的原因说明由 `formatUpstreamErrorDetail`
带进错误消息。原先只给一句 `400 Bad Request`，用户面对图片被拒时无从下手；
现在能看到「unsupported image ... formats: webp, png, jpeg, and gif」。
上游的图片校验策略不该由本服务代劳（替用户转码是越界）。

对没有这个缺陷的上游，判据永不命中，整套机制零影响。

另两项修复（`none` 摘 tools、`stop_sequences` 服务端截断）**在任何上游下都正确**，
因此无条件生效，不进能力表：前者「工具不可见」比任何参数都可靠，后者服务端截断
与上游原生实现结果一致（只是对正确实现的上游略费 token）。

**换上游时要自己确认的一件事**：视觉。DeepSeek 侧支持图片的是
`deepseek-v4-flash-vision-exp` 这类视觉模型，普通 `deepseek-v4-flash` 未必吃图。
路由的 `rule_4_vision_input` 只保证图片不被送去 Sider，保证不了上游模型本身认不认
——配非视觉模型又发图片时，仍会拿到「我没有收到图片」。
- **视觉输入必须原样透传，且只能走 DeepSeek 通道**。上游（实为 `glm-5.3-flash`）
  是 VLM，原生吃图文混排；Sider 通道走 `multi_content` 协议，实测把图片喂过去
  模型会答「我没有收到图片」——HTTP 200、有回答、只是没看见图。这类**静默失败**
  最难被使用方察觉，因此：
  1. `sanitizeMessagesForUpstream` 遇到含图片的消息改走**数组形态** content
     （图片原样保留、其余块仍转文本）；不含图片的消息**必须维持纯字符串**，
     否则请求前缀逐轮变形会打断上游 prompt 缓存；
  2. 路由加 `rule_4_vision_input`，带图片一律走 DeepSeek 且 `allowFallback: false`
     ——fallback 回 Sider 等于把图再丢一次，宁可把错误暴露出来。
- **上游 prompt 缓存是 DeepSeek 成本的最大杠杆**（deepseek-v4-flash 命中价 $0.007/M、
  未命中 $0.22/M，31 倍差）。缓存是自动的、`cache_control` 在该端被忽略，唯一
  决定命中率的是**发往上游的请求前缀是否逐字节稳定**。三条硬约束
  （`deno/test/prompt-cache.test.ts` 守着，改动 adapter 前先看它）：
  1. 固定指令（防模仿提示词等）必须挂 `system`，**绝不能追加到最后一条 user
     消息尾部**——那条消息下一轮就不再是"最后一条"、后缀消失，同一逻辑位置
     两轮字节不同，缓存前缀在那里断掉（实测 15 轮 agent 循环命中率 81%→90%）。
  2. `tools` 数组渲染在最前面，原样透传，不得按轮次增删/重排。
  3. `tool_choice` 只有 `{type:'tool'}` 会被上游 400（thinking 模式限制，
     实测见 `deno/tools/probe-deepseek-tool-choice.ts`），仅这一种摘掉改注入
     文本；auto/any/none 原生透传。注意 `none` 是合法形态，别让它退化进
     "强制指定工具"分支（曾注入 `named "undefined"`）。
  上游 usage 的 `cache_read_input_tokens` / `cache_creation_input_tokens` 必须一路
  透传进统计与 `/stats` 磁贴（`cacheHitRate`）；**`input_tokens` 是未命中的余量**，
  命中越多它越小，单独看它会误以为输入变少了。迭代工具：`deno/tools/probe-deepseek-cache.ts`
  （`PROBE_CACHE_MODE=tail-inject` 跑修复前行为的对照组）。
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
  5. `input_json` 的解析必须容错，`parseLooseToolInputJson` 是三级递进：
     严格 JSON → 补未转义反斜杠 → 补未转义内层双引号。**每加一类畸形都要
     有对应的实测载荷做测试**，因为漏一类就等于「Claude Code 每隔几轮停一次」。
     - 反斜杠：Windows 路径 `C:\Users`、正则 `\s` 等非法转义；
     - 内层双引号：`echo "x"`、`python -c "…"`、`curl -H "…"`——带引号是
       Bash 调用的常态，这一类命中率极高。
  6. **修内层双引号靠 schema 制导，不是靠猜。** 一个 `"` 只有在其后紧跟
     `,"<本工具 input_schema 声明过的键>":` 时才算值结束，键集由
     `collectToolInputKeys(request.tools)` 采集并一路透传到解析器。
     通用 JSON 修复器没有这个信息，只能在「截断」与「合并」之间赌，
     赌错方向会把 `rm -rf /tmp/x` 截成 `rm -rf /`。
     候选取**最早**的合法键终止符；一个都没有才退化为「值延伸到对象结束」——
     这个方向只会让内容偏多，不会截断，对 shell 命令是更安全的失败方向。
     动 `escapeInnerQuotes` 时不要改掉这两条取向。
  7. 还原失败必须走 `textual_tool_use_unparsed` 告警。没有它，现象只是
     「助手莫名停下、要人说『请继续』」，只能靠翻聊天记录截图复原现场。

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

### 深度 probe：Sider 能否承接工具循环

`deno/tools/probe-sider-tool-loop.ts`（共用客户端 `sider-probe-client.ts`）回答的是
可证伪的问题，不是"模型自称支不支持"。**客户端必须做限速感知**（节流 + 1135 冷却
重试 + 被限样本从合规率分母剔除），否则测出来的是吞吐而不是能力。

已得结论（2026-08，claude-sonnet-5 / opus 档）：

- Sider **原生不提供** Anthropic `tool_use` 块；
- 但**契约驱动的文本工具调用可靠**：sonnet-5 单轮 5/5、带引号命令 5/5、
  无需工具时不乱调 5/5、结果续轮不重复调 5/5、15 工具大 schema 5/5，
  多轮循环能收敛。还原可直接复用 `parseTextualToolUseLine`；
- Sider **服务端保存会话**（`cid + parent_message_id`）：首轮 24KB 之后，
  续轮只需发几百字节即可准确召回，因此 603 限制只约束**单轮新增内容**；
- 真正的瓶颈是**吞吐与额度**，不是能力：约 6 次/分钟，且 opus 档单窗口仅 2~3 次、
  200 秒不恢复。**opus 档无法承载 agent 循环**，sonnet 档可以。

因此第 2 期（给 Sider 通道注入工具契约）若要做，**必须只对 sonnet / haiku 开，
opus 档硬排除**——否则每次都白撞一次限速。

## 用量统计

`GET /` 的响应里带 `usage` 字段，回答"最近的调用由谁完成、比例多少、工具用了多少"：

- `totals`：真实上游调用数、sider/deepseek 各自次数、fallback 次数、流式次数、
  工具调用次数，以及 `cachedReplays`（命中重复响应缓存、未触达上游的请求，
  单列以解释"发了 N 次为何统计只有 M 次"）。
- **看板主体统一到近 24 小时窗口**（趋势图、模型表、顶部磁贴、后端占比同一口径），
  历史累计降级为页脚一行 `lifetimeRequests` 对照。混用「全时累计 + 24 小时趋势」正是
  此前「归因三项之和对不上 DeepSeek 总数」的来源——归因字段是后加的，全时累计把没有
  该字段的旧数据永久带着，账永远平不了。实现上 `totals` 与 `models` 由 24 个小时桶
  求和得出，`['stats', ...]` 的全时累计继续写、只留一个 `requests` 给页脚对照。
- `backendShare`：后端占比；`lastHour`：最近 1 小时同口径聚合。
- `tools`：工具调用频次 Top 8；`recent`：最近 10 条明细（时间/模型/后端/
  是否 fallback/工具/是否流式/耗时）。

- `trend`：近 24 小时按小时分桶（空桶保留，时间轴连续）。**趋势由独立的
  按桶累计维护（`trendBuckets`），绝不能改回遍历 `recent`**——`recent` 有
  200 条上限，用它算趋势会让早期桶被静默截断，且失真是单向的（越早掉得
  越狠），图会长成"什么都刚刚发生"的假曲棍球棒，形状比绝对值先坏掉。
  桶按 24 小时窗口淘汰；`models`：按模型聚合的
  请求数与 token 数，并按**归因**拆出该模型走 DeepSeek 的三个来源。
- **模型 × 小时、工具 × 小时用独立 key 前缀**（`['mstat', bucket, model, field]`、
  `['tstat', bucket, name]`），**不塞进 `['stats']`**——塞进去会让 collect() 那次
  全量前缀扫描从几百 key 涨到几千，而 /stats 每 5 秒就扫一次。这些桶走 `sum`
  mutation（无竞争），回收复用趋势桶的「扫描时顺手删旧桶」套路。`sider` 不单独存，
  由 `requests - deepseek` 还原。**不要用 CAS 单 key 存全模型 × 小时**：那是把
  `['live']` 的例外模式套到主路径规模的写量上，会复现「并发 30 条只活 4 条」。
- **快照有 3 秒 TTL 缓存**（`getStatsSnapshot`）：让 KV 扫描频率与客户端数解耦
  （每个打开 /stats 的客户端每 5 秒各触发一次全量扫描）。测试的 `waitForStats`
  每轮必须先 `resetSnapshotCache()`，否则会反复拿到同一份旧快照，把轮询退化成
  「每次等满 3 秒」。TTL 取 3 秒略小于刷新间隔 5 秒，保证每次刷新都能看到新数据。
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

- `recent` 只记白名单字段，不得混入消息内容、**认证 token** 或请求参数。
  （`tokens` 字段是 input+output 的聚合计数，属统计量，不在此列。）
- 回放请求不计入 `requests` 与占比，否则会稀释"由谁完成"的真实比例。
- KV 写失败必须静默（进程内统计仍在），KV 读带 2s 超时并回退进程内——
  统计永远不能拖垮或阻塞请求。
- 归因字段必须同时写进 KV（`usage-stats-kv.ts` 的 `REASON_FIELD` 与
  `MODEL_FIELDS`）。生产上 `/stats` 的聚合读的是 KV，只留进程内的话
  用户看到的三个分项永远是 0。
- 趋势必须由 `trendBuckets` 而非 `recent` 计算（见上文，形状会失真）。
- `['live']` 的写入必须经 `enqueueLive` 串行，绕过它直接 CAS 会丢明细。

## 运行遥测

`utils/sider-telemetry.ts`（Deno 侧，Node 侧为 no-op）把每次 Sider 调用记进
`['tele', hourBucket, ts]`，`GET /stats/telemetry.json` 导出，供离线分析优化调度。
白名单字段：`ts` / `model` / `strategy` / `payloadChars` / `ok` / `siderCode` /
`ms` / `hasTools` / `restoredToolUse`——**不含任何消息内容**。

- **零竞争写**：键用时间戳，天然唯一，`kv.set` 不需要 CAS、不需要串行队列。
  遥测是允许有损的旁路数据，一旦为了「精确条数」去读改写，就把写路径拖回了
  `['live']` 那种全局协调瓶颈。
- **容量硬上限靠写入端节流**（每实例每小时 40 条），不靠读时裁剪。纯时间窗口
  回收不足以保证条数上限（高流量下窗口内条数仍无界），而精确裁剪需要计数器
  读改写。上限 = 25 桶 × 40 条 × 实例数。
- 回收走确定性扫描删旧桶（同趋势桶），**不用 `expireIn`**。
- 埋点在 `noteSiderOutcome`：只有这一层同时握有模型、载荷长度、错误码、耗时与
  `restoredToolUse`。`restoredToolUse` 由 `callSider` 里还原后的 `content` 是否含
  `tool_use` 块得出，是「Max 策略下 Sider 有没有真接住工具」的直接观测。
- **`/stats` 的「Sider 投递健康度」卡片由 `aggregateSiderHealth()` 驱动**，不再只读
  进程内的 `getSiderThrottleSnapshot()`。原因：限流器状态是进程内的，而 Deploy 多
  实例 + 空闲回收让快照几乎必然落在没有碰撞记录的实例上——线上实测那张表长期为空。
  遥测已在 KV 里，聚合出来正好补这个缺口。两个数据源合并渲染：遥测为主表（保证有
  内容），限流器速率/体量上限作为补充列。
  **聚合只扫最近 2 个小时桶**，不读满 25 桶保留窗口：`/stats` 每 5 秒刷新一次，
  全量扫描会让这张卡的开销随实例数线性增长，正是趋势桶当初要避开的坑。
  不要反过来把限流器状态写进 KV——AIMD 是每实例独立收敛的，跨实例共享会破坏语义。

## 测试策略

确定性测试（mock 上游，`deno task test`）：

- `deno/test/hybrid-routing.test.ts`
- `deno/test/deepseek-adapter.test.ts`
- `deno/test/sider-upstream-error.test.ts`
- `deno/test/duplicate-cache-isolation.test.ts`
- `deno/test/messages-hybrid-stream.test.ts`
- `deno/test/usage-attribution.test.ts`
- `deno/test/sider-first-routing.test.ts`
- `deno/test/sider-throttle.test.ts`
- `deno/test/sider-max-strategy.test.ts`
- `deno/test/sider-telemetry.test.ts`
- `deno/test/prompt-cache.test.ts`（上游缓存：usage 缓存字段透传、前缀逐轮稳定、tool_choice 透传边界）
- `deno/test/vision-passthrough.test.ts`（图片块原样透传；无图片时仍压平成字符串以保住缓存前缀）
- `deno/test/tool-choice-none.test.ts`（none 摘 tools 兑现语义、不还原文本工具调用）
- `deno/test/stop-sequences.test.ts`（正文截断、stop_reason 改判、thinking 不受影响，两通道一致）
- `deno/test/upstream-capabilities.test.ts`（能力学习：判据、阈值推导、按上游隔离、拒绝降级）
- `deno/test/upstream-adaptation.test.ts`（adapter 集成：首次自动重试、学后直接注入、无缺陷上游零影响）
- `deno/test/upstream-error-detail.test.ts`（上游 4xx/5xx 的原因说明必须带到调用方）

重点覆盖：

- DeepSeek 原生 `tool_use` 能力补齐。
- DeepSeek 响应侧 `thinking` / `redacted_thinking` 透传。
- Claude Code 工具续轮历史转录，避免 DeepSeek `content[].thinking` passback 400。
- 文本工具调用兜底：两种转录格式都能还原成 `tool_use` 且 `stop_reason` 改判，
  复述历史 id 不还原，普通文本不误判；`input_json` 的三类畸形（未转义反斜杠、
  非法转义、未转义内层双引号）都有实测载荷用例，且命令不得被截断。
- Sider 的 SSE 内业务错误码（如 1135 用量超限）必须上抛，不能吞成空回复。
- 带工具的 `tool_result` 续轮不得被会话延续规则路由回 Sider。
- 重复响应缓存按流式隔离，流式响应不得被等价非流式请求回放。
- Sider-first 三条：长文本判据不误伤续轮（且真长文需求不被误伤）、超体量请求不投
  Sider、熔断按模型隔离且到期自动恢复。
  注意 `sider-availability` 是**模块级全局状态**：任何会真的触发 1135 的测试
  （如 `sider-upstream-error.test.ts`）都必须在 finally 里 `resetSiderAvailability()`，
  否则会顺着文件执行顺序泄漏给后续测试，制造顺序相关的偶发失败。
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

确定性测试里**不要用固定 `setTimeout` 等 KV 落库**。写入是 fire-and-forget，
`['live']` 还要排队串行提交，耗时随机器负载浮动；实测与 `deno fmt` 并发时
固定等待会偶发不够，让门禁无故变红——一个会偶发红的门禁等于没有门禁。
用 `deno/test/usage-stats-kv.test.ts` 里的 `waitForStats` 轮询到期望状态，
顺带把该文件的耗时从 ~1.5s 降到 ~40ms。

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
- `deno/.env` 只作为本地配置输入，不能提交（已被 .gitignore 覆盖）。
