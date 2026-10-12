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
- Bun 适配器、工具、超时、Write 与主控单元回归

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

```powershell
# 终端 1
deno task start
# 终端 2
$env:TEST_ENV="deno-local"
$env:TEST_API_BASE_URL="http://localhost:8000"
npm run test:integration
```

## 配置

测试优先读取 `deno/.env`，不存在才回退根 `.env`；运行时环境变量可覆盖：

```env
TEST_AUTH_TOKEN=your-client-token
TEST_API_BASE_URL=http://localhost:4141
```

## Deno 真实集成门禁

```powershell
$env:E2E_BASE_URL='http://localhost:8000'
$env:E2E_CONTROLLER='false'
$env:E2E_REQUIRE_ALL_PASS='true'
deno task test:e2e
```

该命令用于混合路由实例的基础01–13。主控实例另设服务端开关，客户端注册
`E2E_CONTROLLER=true` 后明确运行 `deno task test:e2e 14 15`。

更多说明见[完整测试指南](TEST-README.md)。
