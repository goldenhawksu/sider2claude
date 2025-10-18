@echo off
REM 测试 Deno Deploy 生产环境
echo ========================================
echo 测试 Deno Deploy 生产环境
echo 环境: deno-deploy
echo API: https://your-app.deno.dev
echo ========================================
echo.

set TEST_ENV=deno-deploy
bun run run-all-tests.ts
