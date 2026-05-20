@echo off
REM 兼容入口：委托给统一服务级集成测试 runner。
pushd "%~dp0\.."
if "%1"=="" (
  bun run test/run-all-tests.ts
) else if "%1"=="all" (
  bun run test/run-all-tests.ts
) else if "%1"=="1" (
  bun run test/run-all-tests.ts 01-health-check.test.ts
) else if "%1"=="2" (
  bun run test/run-all-tests.ts 02-basic-messages.test.ts
) else if "%1"=="3" (
  bun run test/run-all-tests.ts 03-session-persistence.test.ts
) else if "%1"=="4" (
  bun run test/run-all-tests.ts 04-streaming.test.ts
) else if "%1"=="5" (
  bun run test/run-all-tests.ts 05-token-counting.test.ts
) else (
  bun run test/run-all-tests.ts %*
)
set EXIT_CODE=%ERRORLEVEL%
popd
exit /b %EXIT_CODE%
