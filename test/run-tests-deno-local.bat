@echo off
REM 测试 Deno 本地服务器 (localhost:4142)
echo ========================================
echo 测试 Deno 本地服务器
echo 环境: deno-local
echo API: http://localhost:4142
echo ========================================
echo.

set TEST_ENV=deno-local
bun run run-all-tests.ts
