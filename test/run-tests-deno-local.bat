@echo off
REM 测试 Deno 本地服务器 (localhost:8000)
pushd "%~dp0\.."
echo ========================================
echo 测试 Deno 本地服务器
echo 环境: deno-local
echo API: http://localhost:8000
echo ========================================
echo.

set TEST_ENV=deno-local
bun run test/run-all-tests.ts
set EXIT_CODE=%ERRORLEVEL%
popd
exit /b %EXIT_CODE%
