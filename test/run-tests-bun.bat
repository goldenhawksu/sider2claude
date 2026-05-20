@echo off
REM 测试 Bun 本地服务器 (localhost:4141)
pushd "%~dp0\.."
echo ========================================
echo 测试 Bun 本地服务器
echo 环境: bun-local
echo API: http://localhost:4141
echo ========================================
echo.

set TEST_ENV=bun-local
bun run test/run-all-tests.ts
set EXIT_CODE=%ERRORLEVEL%
popd
exit /b %EXIT_CODE%
