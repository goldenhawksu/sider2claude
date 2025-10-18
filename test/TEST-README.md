# 测试套件使用指南

## 📋 测试配置

测试套件现在支持三种环境的自动切换：

| 环境 | API 地址 | 认证 Token | 说明 |
|------|---------|-----------|------|
| `bun-local` | http://localhost:4141 | your-custom-auth-token-here | Bun 本地开发服务器（默认） |
| `deno-local` | http://localhost:4142 | your-custom-auth-token-here | Deno 本地开发服务器 |
| `deno-deploy` | https://your-app.deno.dev | sk-this-is-deno-key | Deno Deploy 生产环境 |

配置文件位置：`test/test.config.ts`

---

## 🚀 快速运行测试

### Windows

```bash
# 测试 Bun 本地服务器
cd test
run-tests-bun.bat

# 测试 Deno 本地服务器
run-tests-deno-local.bat

# 测试 Deno Deploy 生产环境
run-tests-deno-deploy.bat
```

### Linux / macOS

```bash
# 测试 Bun 本地服务器
cd test
./run-tests-bun.sh

# 测试 Deno 本地服务器
./run-tests-deno-local.sh

# 测试 Deno Deploy 生产环境
./run-tests-deno-deploy.sh
```

---

## 🔧 手动指定环境

### 方法 1: 使用环境变量

```bash
# Windows
set TEST_ENV=deno-local
bun run run-all-tests.ts

# Linux/macOS
export TEST_ENV=deno-local
bun run run-all-tests.ts
```

### 方法 2: 运行单个测试文件

```bash
# Windows
set TEST_ENV=bun-local
bun run 01-health-check.test.ts

# Linux/macOS
export TEST_ENV=bun-local
bun run 01-health-check.test.ts
```

---

## 📦 测试文件列表

| 文件 | 描述 | 测试数量 |
|------|------|---------|
| `01-health-check.test.ts` | 健康检查和 CORS 配置 | 2 |
| `02-basic-messages.test.ts` | 基础消息 API 功能 | 5 |
| `03-session-persistence.test.ts` | 会话保持和多轮对话 | 3 |
| `04-streaming.test.ts` | 流式响应功能 | 3 |
| `05-token-counting.test.ts` | Token 计数端点 | 5 |

**总计**: 18 个测试用例

---

## 🛠️ 测试前准备

### 1. 启动被测试的服务器

**Bun 版本**:
```bash
cd c:/github-repo/sider2claude
bun run dev
# 服务器将在 http://localhost:4141 运行
```

**Deno 版本**:
```bash
cd c:/github-repo/sider2claude/deno
deno task dev
# 服务器将在 http://localhost:4142 运行
```

### 2. 确认环境变量

确保服务器已正确配置环境变量（`.env` 文件）：

```bash
# 必需
AUTH_TOKEN=your-custom-auth-token-here
SIDER_AUTH_TOKEN=eyJhbGci...

# 可选（启用混合路由时需要）
ANTHROPIC_API_KEY=sk-ant-...
```

---

## 📊 测试输出示例

```
🚀 Sider2Claude 完整测试套件
⏰ 开始时间: 2025/10/18 10:50:00
🌍 测试环境: bun-local
💡 提示: 使用 TEST_ENV=deno-local 或 TEST_ENV=deno-deploy 切换环境
======================================================================

📋 找到 5 个测试文件:

   1. 01-health-check.test.ts
   2. 02-basic-messages.test.ts
   3. 03-session-persistence.test.ts
   4. 04-streaming.test.ts
   5. 05-token-counting.test.ts

======================================================================
🧪 运行测试文件: 01-health-check.test.ts
======================================================================
🚀 开始健康检查测试...
📍 测试配置:
   环境: bun-local
   说明: Bun 本地开发服务器 (端口 4141)
   API 地址: http://localhost:4141
   认证 Token: your-custom-auth-tok...
============================================================

...

======================================================================
📊 测试总结
======================================================================

测试结果:
  1. ✅ 01-health-check.test.ts
     通过 | 耗时: 0.05s
  2. ✅ 02-basic-messages.test.ts
     通过 | 耗时: 15.23s
  3. ✅ 03-session-persistence.test.ts
     通过 | 耗时: 7.51s
  4. ✅ 04-streaming.test.ts
     通过 | 耗时: 35.12s
  5. ✅ 05-token-counting.test.ts
     通过 | 耗时: 0.08s

统计:
  通过: 5/5
  失败: 0/5
  成功率: 100.0%
  总耗时: 57.99s

⏰ 结束时间: 2025/10/18 10:51:00

✅ 所有测试通过！
```

---

## 🔍 故障排查

### 测试失败常见原因

1. **服务器未启动**
   - 错误：`fetch failed` 或 `ECONNREFUSED`
   - 解决：启动对应的服务器（Bun 或 Deno）

2. **认证失败 (401)**
   - 错误：`401 Unauthorized`
   - 解决：检查服务器 `.env` 中的 `AUTH_TOKEN` 与测试配置是否一致

3. **端口冲突**
   - 错误：`EADDRINUSE`
   - 解决：检查端口 4141 (Bun) 或 4142 (Deno) 是否被占用

4. **Sider API 配额不足**
   - 错误：`Response received but no text content`
   - 解决：等待 Sider AI 配额重置或更换 Token

### 查看后台服务器日志

如果服务器在后台运行：

```bash
# 查看 Bun 服务器输出
# (在启动服务器的终端查看)

# 或者重新前台启动查看日志
bun run dev
```

---

## 📝 修改测试配置

编辑 `test/test.config.ts` 文件：

```typescript
const configs: Record<string, TestConfig> = {
  'bun-local': {
    apiBaseUrl: 'http://localhost:4141',  // 修改端口
    authToken: 'your-token-here',         // 修改 Token
    environment: 'bun-local',
    description: 'Bun 本地开发服务器',
  },
  // ... 其他配置
};
```

---

## 🎯 持续集成 (CI)

在 CI 环境中运行测试：

```bash
# GitHub Actions / GitLab CI 示例
- name: Run Tests
  run: |
    cd test
    export TEST_ENV=deno-deploy
    bun run run-all-tests.ts
```

---

## ✅ 验证修复

运行特定测试验证 Bug 修复：

```bash
# 验证会话保持修复
bun run 03-session-persistence.test.ts

# 验证 Token 计数修复
bun run 05-token-counting.test.ts
```

---

**最后更新**: 2025-10-18
**维护者**: Claude Code AI Agent
