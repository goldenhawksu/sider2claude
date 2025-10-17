# Sider2Claude 开发规范 - AI Agent 专用

## 项目概述

**核心功能**: API转换服务，将Sider AI API转换为Anthropic API格式
**关键需求**: 会话保持 + 内置工具调用
**技术栈**: TypeScript + Hono + Bun
**参考项目**: copilot-api (必须保持架构一致性)

## 项目架构约束

### 目录结构规范
```
src/
├── types/          # 类型定义 - 所有模块的依赖源
├── middleware/     # 中间件 - 认证和请求处理
├── routes/         # 路由处理 - API端点实现
├── utils/          # 工具类 - 核心转换逻辑
└── main.ts         # 入口文件 - 路由注册
```

### 模块依赖层次
- **types** → **utils** → **routes** → **main.ts**
- **middleware** → **routes**

## 会话保持开发规范

### 核心文件职责
- `utils/sider-session-manager.ts` - **真实会话ID管理**
- `utils/conversation-manager.ts` - **模拟会话管理** (降级模式)
- `utils/sider-conversation.ts` - **Sider API会话历史获取**

### 会话保持实现规则

#### 必须DO
- 优先使用 `convertAnthropicToSiderAsync` 获取真实会话历史
- 会话ID通过 `cid` query参数或 `X-Conversation-ID` header传递
- 失败时自动降级到 `convertAnthropicToSiderSync` 简化模式
- 在 `message_start` 事件中捕获真实的 `cid` 和 `parent_message_id`
- 使用 `saveSiderSession` 保存真实会话元数据

#### 严禁DON'T
- **禁止**删除现有的会话管理器文件
- **禁止**硬编码会话ID或父消息ID
- **禁止**忽略会话历史获取的错误处理
- **禁止**修改会话ID的传递机制

### 会话数据流程
```
1. 请求携带 cid → 2. 获取Sider历史 → 3. 构建上下文 → 4. 调用API → 5. 保存新会话数据
```

## 工具调用开发规范

### 核心文件职责
- `types/anthropic.ts` - **工具调用类型定义**
- `utils/request-converter.ts` - **工具格式转换**
- `routes/messages.ts` - **工具调用处理逻辑**

### 工具调用实现规则

#### 必须DO
- 参考 `copilot-api/src/routes/messages/non-stream-translation.ts` 的实现
- 在 `buildSafeToolsConfig` 中启用工具转换（当前被禁用）
- 支持 `tools` 和 `tool_choice` 参数的完整转换
- 实现工具调用结果的正确响应格式
- 使用 Anthropic 标准的工具调用规范

#### 严禁DON'T
- **禁止**破坏现有的API兼容性
- **禁止**修改 Anthropic API 的工具调用接口格式
- **禁止**忽略工具调用的错误处理
- **禁止**硬编码工具配置

### 工具调用数据流程
```
Anthropic tools → 转换为Sider格式 → 调用Sider API → 解析工具结果 → 转换回Anthropic格式
```

## 关键文件交互规范

### 类型定义连动
- 修改 `types/anthropic.ts` → **必须检查**: `utils/request-converter.ts`, `utils/response-converter.ts`, `routes/messages.ts`
- 修改 `types/sider.ts` → **必须检查**: `utils/sider-client.ts`, `utils/sider-conversation.ts`

### 转换逻辑连动  
- 修改 `utils/request-converter.ts` → **必须验证**: `routes/messages.ts` 中的调用
- 修改 `utils/sider-client.ts` → **必须验证**: 与 `utils/sider-session-manager.ts` 的协作

### 路由处理连动
- 添加新API端点 → **必须更新**: `main.ts` 中的路由注册
- 修改认证逻辑 → **必须检查**: 所有使用 `requireAuth` 的路由

## copilot-api 兼容性规范

### 技术栈约束
- **必须使用**: Hono web框架
- **必须使用**: Bun 运行时
- **必须使用**: citty CLI框架 (未来CLI功能)
- **必须使用**: consola 日志系统

### API端点约束
- **必须保持**: `/v1/messages` 端点签名不变
- **必须保持**: `/v1/messages/count_tokens` 端点兼容
- **必须实现**: 与 Claude Code 兼容的响应格式

### 参考实现模式
- 工具调用: `copilot-api/src/routes/messages/non-stream-translation.ts`
- 流式响应: `copilot-api/src/routes/messages/stream-translation.ts`
- 类型定义: `copilot-api/src/routes/messages/anthropic-types.ts`

## AI 决策优先级

### 优先级排序 (重要性递减)
1. **保持 Anthropic API 兼容性** - 绝不能破坏 Claude Code 集成
2. **维护会话保持功能** - 确保多轮对话正常工作
3. **实现工具调用功能** - 支持 Claude Code 的工具使用
4. **保持 copilot-api 架构一致性** - 技术栈和接口设计
5. **维护 Sider API 调用稳定性** - 认证和请求格式

### 模糊决策处理
- 遇到工具调用实现不确定时 → 参考 copilot-api 相应文件
- 遇到会话管理冲突时 → 优先保持现有功能不破坏
- 遇到API兼容性问题时 → 优先保证 Claude Code 能正常使用

## 具体实现约束

### 会话保持约束
- 新会话: 使用 `convertAnthropicToSiderSync` 
- 续话: 优先 `convertAnthropicToSiderAsync`，失败降级
- 会话数据: 必须从 `message_start` 事件提取真实数据
- 错误处理: 会话历史获取失败时不能中断整个请求

### 工具调用约束
- 工具定义: 必须完整转换 Anthropic 工具格式到 Sider 格式
- 工具结果: 必须正确解析 Sider 工具执行结果
- 错误恢复: 工具调用失败时提供降级响应
- 兼容性: 保持与 Claude Code 工具调用规范一致

## 禁止事项

### 架构禁止
- **严禁**更换 Hono 框架为其他框架
- **严禁**修改现有 `/v1/messages` 端点签名
- **严禁**破坏 TypeScript 类型安全
- **严禁**删除会话管理相关文件

### 功能禁止  
- **严禁**硬编码 Sider API 响应格式
- **严禁**忽略工具调用的类型验证
- **严禁**跳过会话历史的错误处理
- **严禁**修改 Anthropic API 兼容格式

### 开发流程禁止
- **严禁**直接修改 types 而不检查相关 utils
- **严禁**添加新依赖而不验证 bun 兼容性
- **严禁**修改路由而不更新 main.ts 注册
- **严禁**在没有参考 copilot-api 时实现复杂功能

## 当前缺失功能分析

### 工具调用缺失
- `buildSafeToolsConfig` 函数当前被禁用
- 缺少工具调用结果的完整处理链路
- 缺少工具调用错误的标准化处理

### CLI 功能缺失
- 缺少 citty 框架的入口文件
- 缺少 Claude Code 配置生成功能
- 缺少命令行参数处理

### 流式响应优化
- 当前流式响应为模拟实现
- 可参考 copilot-api 实现真正的 SSE 流

