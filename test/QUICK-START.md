# 快速开始 - 测试

## 确定性回归

从仓库根目录运行：

```bash
npm run test:regression
```

该命令不访问外部服务，覆盖：

- Deno 单测
- Deno 主入口类型检查
- Sider probe 脚本类型检查
- Node/Bun TypeScript 检查

## 服务级集成测试

先启动服务：

```bash
bun run dev
```

再运行：

```bash
npm run test:integration
```

Deno 本地服务：

```bash
deno task dev
$env:TEST_ENV="deno-local"
$env:TEST_API_BASE_URL="http://localhost:8000"
npm run test:integration
```

## 配置

测试会读取根目录 `.env`，也可以用环境变量覆盖：

```bash
TEST_AUTH_TOKEN=your-client-token
TEST_API_BASE_URL=http://localhost:4141
```

更多说明见 `TEST-README.md`。
