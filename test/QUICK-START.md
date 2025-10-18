# 快速开始 - 测试指南

## 🚀 一键运行测试

### Windows

```bash
cd test

# 测试 Bun 本地服务器 (默认)
run-tests-bun.bat

# 测试 Deno 本地服务器
run-tests-deno-local.bat

# 测试 Deno Deploy 生产环境
run-tests-deno-deploy.bat
```

### Linux / macOS

```bash
cd test

# 测试 Bun 本地服务器 (默认)
./run-tests-bun.sh

# 测试 Deno 本地服务器
./run-tests-deno-local.sh

# 测试 Deno Deploy 生产环境
./run-tests-deno-deploy.sh
```

---

## ⚙️ 测试前准备

### 1. 启动服务器

**Bun 版本**:
```bash
cd c:/github-repo/sider2claude
bun run dev
# 服务器在 http://localhost:4141
```

**Deno 版本**:
```bash
cd c:/github-repo/sider2claude/deno
deno task dev
# 服务器在 http://localhost:4142
```

### 2. 检查环境变量

确保 `.env` 文件已配置：
```bash
AUTH_TOKEN=your-custom-auth-token-here
SIDER_AUTH_TOKEN=eyJhbGci...
```

---

## 📊 预期结果

```
✅ 所有测试通过！

统计:
  通过: 5/5
  失败: 0/5
  成功率: 100.0%
  总耗时: ~58s
```

---

## 📖 更多信息

- 详细使用说明: [TEST-README.md](TEST-README.md)
- 完整测试报告: [../docs/FINAL-TEST-REPORT-2025-10-18.md](../docs/FINAL-TEST-REPORT-2025-10-18.md)
- Bug 修复总结: [../docs/BUG-FIXES-SUMMARY.md](../docs/BUG-FIXES-SUMMARY.md)
