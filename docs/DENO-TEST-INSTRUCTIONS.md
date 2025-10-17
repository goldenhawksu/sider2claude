# Deno 部署测试指南

**创建时间**: 2025-10-17
**目的**: 验证 Deno 部署的混合路由功能

---

## 📋 测试准备

我已经创建了一个完整的 Deno 部署测试套件: `test/test-deno-deployment.ts`

这个测试套件将验证以下功能:

### 测试覆盖范围

1. ✅ **健康检查端点** - 验证服务正常运行
2. ✅ **API 信息端点** - 验证混合路由功能标识
3. ✅ **后端状态查询** - 验证配置正确加载
4. ✅ **简单对话路由** - 验证 Sider AI 路由
5. ✅ **工具调用路由** - 验证 Anthropic API 路由
6. ✅ **认证机制** - 验证 Token 认证
7. ✅ **Token 计数** - 验证辅助功能
8. ✅ **错误处理** - 验证异常处理

---

## 🚀 测试选项

### 选项 1: 测试 Deno Deploy 线上环境 (推荐)

如果你已经部署到 Deno Deploy,请提供你的部署 URL。

**步骤**:

1. 找到你的 Deno Deploy URL (类似: `https://your-project.deno.dev`)

2. 运行测试:
   ```bash
   cd test
   DENO_DEPLOY_URL=https://your-project.deno.dev deno run --allow-net test-deno-deployment.ts
   ```

**我需要的信息**:
- 你的 Deno Deploy URL: `https://____________.deno.dev`

---

### 选项 2: 本地测试 Deno 版本

如果还没有部署,可以先本地测试 Deno 版本。

**步骤**:

1. 启动本地 Deno 服务器:
   ```bash
   cd deno
   deno run --allow-net --allow-env main.ts
   ```

2. 在另一个终端运行测试:
   ```bash
   cd test
   DENO_DEPLOY_URL=http://localhost:8000 deno run --allow-net test-deno-deployment.ts
   ```

---

### 选项 3: 我直接执行测试 (如果你授权)

你只需要提供:
- Deno Deploy URL (或确认使用本地测试)
- 我将自动执行完整测试并生成报告

---

## 📊 预期测试结果

### 成功标准

如果一切正常,你应该看到:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 Test Summary
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Total Tests: 8
✅ Passed: 6-8
❌ Failed: 0
⏭️  Skipped: 0-2
Success Rate: 100%
```

### 关键验证点

- ✅ 健康检查返回 `status: "ok"`
- ✅ API 信息显示 `hybrid_routing: true`
- ✅ 后端状态显示至少一个后端启用
- ✅ 简单对话路由到 Sider AI
- ✅ 工具调用路由到 Anthropic API (如果配置)
- ✅ 认证正确拒绝未授权请求

---

## 🔍 详细测试说明

### Test 1: Health Check
验证 `/health` 端点:
- 返回 200 OK
- 包含 `status: "ok"`
- 包含服务信息

### Test 2: API Info
验证 `/` 端点:
- 返回 200 OK
- 包含 `features.hybrid_routing: true`
- 包含 `endpoints.backends_status`

### Test 3: Backend Status
验证 `/v1/messages/backends/status` 端点:
- 返回 200 OK
- 显示后端配置
- 显示路由配置
- 显示会话统计

### Test 4: Simple Chat
验证简单对话路由:
- 请求: 简单的 "Hello" 消息
- 预期: 路由到 Sider AI
- 验证: `X-Backend-Used: sider` (如果有)
- 验证: `X-Routing-Rule: rule_5_simple_chat_prefer_sider` (如果有)

### Test 5: Tool Call
验证工具调用路由:
- 请求: 包含 Read 工具的消息
- 预期: 路由到 Anthropic API
- 验证: `X-Backend-Used: anthropic` (如果配置)
- 验证: `X-Routing-Rule: rule_2_claude_tools`

### Test 6: Authentication
验证认证机制:
- 请求: 不带 Authorization header
- 预期: 返回 401 Unauthorized

### Test 7: Token Count
验证 Token 计数功能:
- 请求: `/v1/messages/count_tokens`
- 预期: 返回 Token 数量

### Test 8: Error Handling
验证错误处理:
- 请求: 无效的请求体
- 预期: 返回 4xx 错误

---

## 🎯 核心验证目标

我将特别关注以下核心功能:

### 1. 混合路由决策引擎
- ✅ 简单对话是否正确路由到 Sider AI
- ✅ 工具调用是否正确路由到 Anthropic API
- ✅ 路由规则 ID 是否正确

### 2. 后端配置加载
- ✅ 环境变量是否正确读取
- ✅ 后端启用状态是否正确
- ✅ 路由配置是否正确

### 3. 会话管理
- ✅ 会话 ID 是否正确生成和跟踪
- ✅ 会话统计是否正确更新

### 4. API 兼容性
- ✅ Anthropic API 格式是否完全兼容
- ✅ 响应格式是否符合标准

### 5. 错误处理
- ✅ 认证失败是否正确处理
- ✅ 无效请求是否正确处理
- ✅ 后端故障是否触发降级

---

## 📝 测试报告格式

测试完成后,我将生成一份详细报告,包含:

1. **执行摘要** - 总体成功率和关键发现
2. **详细测试结果** - 每个测试的状态和耗时
3. **路由验证** - 路由决策是否正确
4. **性能数据** - 响应时间统计
5. **问题诊断** - 失败测试的详细分析
6. **改进建议** - 优化建议 (如果有)

---

## 🤔 下一步

**请告诉我**:

1. **你的 Deno Deploy URL** (如果已部署)
   - 例如: `https://sider2claude-hybrid.deno.dev`

2. **或者确认使用本地测试**
   - 我将启动本地 Deno 服务器并测试

3. **或者授权我直接执行测试**
   - 我将自动完成所有步骤并生成报告

---

**准备就绪!** 等待你的指示后,我将立即开始完整的测试验证。🚀
