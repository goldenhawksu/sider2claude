@echo off
REM 测试 Deno Deploy 生产环境
pushd "%~dp0\.."
echo ========================================
echo 测试 Deno Deploy 生产环境
echo 环境: deno-deploy
echo API: 由 TEST_API_BASE_URL 或 DENO_DEPLOY_URL 指定
echo ========================================
echo.

set TEST_ENV=deno-deploy
bun run test/run-all-tests.ts
set EXIT_CODE=%ERRORLEVEL%
popd
exit /b %EXIT_CODE%
