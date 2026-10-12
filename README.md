# Sider2Claude

Sider2Claude 为 Claude Code、VS Code 插件和其他客户端提供 Anthropic Messages API 兼容接口，支持 Bun 本地运行和 Deno 部署。

- 普通对话优先使用 Sider；工具、视觉和 XML 安全分类等能力由配置的 Anthropic 兼容后端补齐。
- 可开启 Sider 主控模式，由 Sider 规划和选择工具，Claude Code／MCP 客户端执行实际操作。
- cc-switch 的 `[1M]`、`[200k]` 等窗口标签在发送到 Sider 前剥离；对外保留请求名，主控状态与限流按基础名共享。
- 明确的无工具 XML 安全分类使用原生兼容后端；显式 `thinking: disabled` 会被保留。
- 长 Write 支持严格参数校验、正文引用和写后回读验证；当前模型目录包含 106 个模型。

## 文档入口

| 文档 | 用途 |
| --- | --- |
| [项目说明](README_CN.md) | 架构、配置、运行时差异及能力边界 |
| [用户使用指南](docs/用户使用指南.md) | 启动服务、接入 cc-switch／VS Code、PPT 工作流与排障 |
| [API 参考](docs/API参考.md) | 接口、鉴权、模型、SSE、工具续轮和错误语义 |
| [Sider 主控模式](docs/Sider主控模式.md) | 持久化、分片、正文引用及限流 |
| [测试指南](test/TEST-README.md) | 确定性回归、真实集成套件 01–15、验收标准 |
| [开发测试发布 SOP](docs/开发测试发布SOP.md) | 本地验证、提交、自动部署和生产复验 |
| [文档目录](docs/README.md) | 当前指南和历史验证报告 |

从仓库根目录运行 `npm ci`，按[用户使用指南](docs/用户使用指南.md)配置 `deno/.env` 后，使用 `bun run dev` 或 `deno task start` 启动。未经 `PORT` 覆盖时，Bun 默认端口为 4141，Deno 为 8000。

文档核对基线：2026-10-12，代码提交 `451a4f2`。该版本已通过 Deno 352 项、Bun 49 项确定性测试，以及基础 88 项和窗口／分类 3 项真实集成测试；详细范围见[修复报告](docs/cc-switch上下文窗口兼容修复_20261012.md)。
