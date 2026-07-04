@echo off
chcp 65001 >nul 2>nul
setlocal EnableExtensions EnableDelayedExpansion

set "ROOT=%~dp0"
set "ROOT=%ROOT:~0,-1%"
set "ENV_FILE=%ROOT%\.env"
set "ENV_EXAMPLE=%ROOT%\deno\.env.example"
set "DENO_MAIN=%ROOT%\deno\main.ts"
set "BUN_MAIN=%ROOT%\src\main.ts"
set "RUNTIME_DIR=%ROOT%\.runtime"
set "LOG_DIR=%ROOT%\logs"
set "PID_FILE=%RUNTIME_DIR%\sider2claude.pid"
set "OUT_LOG=%LOG_DIR%\sider2claude.out.log"
set "ERR_LOG=%LOG_DIR%\sider2claude.err.log"
set "RUNTIME_MODE_FILE=%RUNTIME_DIR%\runtime.mode"

if "%~1"=="" goto menu

set "COMMAND=%~1"
if /i "%COMMAND%"=="help"    goto help
if /i "%COMMAND%"=="--help"  goto help
if /i "%COMMAND%"=="-h"      goto help
if /i "%COMMAND%"=="start"   goto start
if /i "%COMMAND%"=="dev"     goto dev
if /i "%COMMAND%"=="stop"    goto stop
if /i "%COMMAND%"=="restart" goto restart
if /i "%COMMAND%"=="status"  goto status
if /i "%COMMAND%"=="health"  goto health
if /i "%COMMAND%"=="config"  goto config
if /i "%COMMAND%"=="edit-config" goto editConfig
if /i "%COMMAND%"=="init-config" goto initConfig
if /i "%COMMAND%"=="logs"    goto logs
if /i "%COMMAND%"=="set"     goto setConfigArg
if /i "%COMMAND%"=="pull"    goto gitPull
if /i "%COMMAND%"=="setup"   goto setup
if /i "%COMMAND%"=="test"    goto test
if /i "%COMMAND%"=="typecheck" goto typecheck
if /i "%COMMAND%"=="clean"   goto clean

echo Unknown command: %COMMAND%
echo.
goto help


REM ================================================================
REM  MAIN MENU (主菜单)
REM ================================================================
:menu
cls
echo.
echo ================================================================
echo             Sider2Claude 管理控制台
echo ================================================================
echo.
call :readPort
call :detectRuntime
echo   项目路径 : %ROOT%
echo   运行环境 : !RUNTIME_LABEL!
echo   API 地址 : http://127.0.0.1:%PORT%
echo   配置文件 : %ENV_FILE%
echo.
echo   +-- Git 代码管理 -----------------------------+
echo   ^|  1. 拉取最新代码 (git pull)                ^|
echo   ^|  2. 查看 Git 状态 (git status)             ^|
echo   ^|  3. 查看最近提交 (git log)                 ^|
echo   +-- 环境配置 ---------------------------------+
echo   ^|  4. 安装/更新依赖 (bun/npm install)        ^|
echo   ^|  5. 检查运行环境 (environment check)       ^|
echo   ^|  6. 初始化 .env 配置 (init)                ^|
echo   ^|  7. 编辑 .env 配置 (edit)                  ^|
echo   +-- 服务控制 ---------------------------------+
echo   ^|  8. 启动服务 (start - 后台运行)            ^|
echo   ^|  9. 开发模式 (dev - 前台+热重载)           ^|
echo   ^| 10. 停止服务 (stop)                        ^|
echo   ^| 11. 重启服务 (restart)                     ^|
echo   ^| 12. 服务状态 (status)                      ^|
echo   +-- 配置管理 ---------------------------------+
echo   ^| 13. 查看当前配置 (show config)             ^|
echo   ^| 14. 设置配置参数 (set config)              ^|
echo   ^| 15. 切换运行环境 (switch Deno/Bun)         ^|
echo   +-- 测试 ^& 诊断 ------------------------------+
echo   ^| 16. 健康检查 (health check)                ^|
echo   ^| 17. 查看日志 (view logs)                   ^|
echo   ^| 18. 运行回归测试 (run tests)               ^|
echo   ^| 19. 类型检查 (type check)                  ^|
echo   ^| 20. 清理缓存和构建产物 (clean)             ^|
echo   +-- 工具 -------------------------------------+
echo   ^| 21. 导出 cc-switch 配置                    ^|
echo   +---------------------------------------------+
echo   ^|  0. 退出 (exit)                            ^|
echo   +---------------------------------------------+
echo.

set /p "CHOICE=  请选择 [0-21]: "

if "%CHOICE%"=="1"  call :gitPullAction        & goto menuEnd
if "%CHOICE%"=="2"  call :gitStatusAction      & goto menuEnd
if "%CHOICE%"=="3"  call :gitLogAction         & goto menuEnd
if "%CHOICE%"=="4"  call :installDepsAction    & goto menuEnd
if "%CHOICE%"=="5"  call :checkEnvAction       & goto menuEnd
if "%CHOICE%"=="6"  call :initConfigAction     & goto menuEnd
if "%CHOICE%"=="7"  call :editConfigAction     & goto menuEnd
if "%CHOICE%"=="8"  call :startAction          & goto menuEnd
if "%CHOICE%"=="9"  call :devAction            & goto menuEnd
if "%CHOICE%"=="10" call :stopAction           & goto menuEnd
if "%CHOICE%"=="11" call :restartAction        & goto menuEnd
if "%CHOICE%"=="12" call :statusAction         & goto menuEnd
if "%CHOICE%"=="13" call :configAction         & goto menuEnd
if "%CHOICE%"=="14" call :setConfigPrompt      & goto menuEnd
if "%CHOICE%"=="15" call :switchRuntimeAction  & goto menuEnd
if "%CHOICE%"=="16" call :healthAction         & goto menuEnd
if "%CHOICE%"=="17" call :logsAction           & goto menuEnd
if "%CHOICE%"=="18" call :testAction           & goto menuEnd
if "%CHOICE%"=="19" call :typecheckAction      & goto menuEnd
if "%CHOICE%"=="20" call :cleanAction          & goto menuEnd
if "%CHOICE%"=="21" call :ccSwitchExportAction & goto menuEnd
if "%CHOICE%"=="0"  exit /b 0

:menuEnd
pause
goto menu


REM ================================================================
REM  HELP (帮助)
REM ================================================================
:help
echo.
echo Sider2Claude 管理控制台
echo.
echo 用法:
echo   sider.bat                  交互式菜单
echo   sider.bat ^<command^>       直接执行命令
echo.
echo 命令:
echo   start        后台启动服务
echo   dev          前台开发模式 (热重载)
echo   stop         停止服务
echo   restart      重启服务
echo   status       查看服务状态
echo   health       健康检查 (GET /health)
echo   config       查看当前 .env 配置
echo   edit-config  用记事本编辑 .env
echo   init-config  从模板创建 .env
echo   logs         查看日志
echo   set KEY VAL  设置 .env 中的配置项
echo   pull         拉取最新代码 (git pull)
echo   setup        安装依赖
echo   test         运行回归测试
echo   typecheck    运行类型检查
echo   clean        清理缓存和构建产物
echo.
echo 常用配置键:
echo   PORT, AUTH_TOKEN, SIDER_AUTH_TOKEN, DEEPSEEK_API_KEY
echo   DEEPSEEK_BASE_URL, DEEPSEEK_MODEL, DEFAULT_BACKEND
echo   AUTO_FALLBACK, PREFER_SIDER_FOR_CHAT, DEBUG_ROUTING
echo   REQUEST_TIMEOUT
exit /b 0


REM ================================================================
REM  DIRECT COMMAND DISPATCH (命令分发)
REM ================================================================
:start
call :startAction
exit /b %ERRORLEVEL%

:dev
call :devAction
exit /b %ERRORLEVEL%

:stop
call :stopAction
exit /b %ERRORLEVEL%

:restart
call :restartAction
exit /b %ERRORLEVEL%

:status
call :statusAction
exit /b %ERRORLEVEL%

:health
call :healthAction
exit /b %ERRORLEVEL%

:config
call :configAction
exit /b %ERRORLEVEL%

:editConfig
call :editConfigAction
exit /b %ERRORLEVEL%

:initConfig
call :initConfigAction
exit /b %ERRORLEVEL%

:logs
call :logsAction
exit /b %ERRORLEVEL%

:setConfigArg
if "%~2"=="" (echo 缺少 KEY。 & exit /b 1)
if "%~3"=="" (echo 缺少 VALUE。 & exit /b 1)
call :setEnvValue "%~2" "%~3"
exit /b %ERRORLEVEL%

:gitPull
call :gitPullAction
exit /b %ERRORLEVEL%

:setup
call :installDepsAction
exit /b %ERRORLEVEL%

:test
call :testAction
exit /b %ERRORLEVEL%

:typecheck
call :typecheckAction
exit /b %ERRORLEVEL%

:clean
call :cleanAction
exit /b %ERRORLEVEL%


REM ================================================================
REM  1. 拉取最新代码 (git pull --ff-only)
REM ================================================================
:gitPullAction
call :ensureGit
if errorlevel 1 exit /b 1
echo.
echo [Git Pull] 拉取最新代码...
pushd "%ROOT%"
git pull --ff-only
set "GIT_EXIT=%ERRORLEVEL%"
popd
if %GIT_EXIT% equ 0 (
  echo [OK] 拉取成功。
) else (
  echo [FAIL] Pull failed (exit %GIT_EXIT%). Check for local unpushed changes.
)
exit /b %GIT_EXIT%


REM ================================================================
REM  2. 查看 Git 状态 (git status)
REM ================================================================
:gitStatusAction
call :ensureGit
if errorlevel 1 exit /b 1
echo.
echo [Git Status] 工作区状态:
pushd "%ROOT%"
git status --short
popd
exit /b 0


REM ================================================================
REM  3. 查看最近提交 (git log)
REM ================================================================
:gitLogAction
call :ensureGit
if errorlevel 1 exit /b 1
echo.
echo [Git Log] 最近 10 条提交:
pushd "%ROOT%"
git log --oneline -10
popd
exit /b 0


REM ================================================================
REM  4. 安装/更新依赖
REM ================================================================
:installDepsAction
echo.
echo [Install] 安装依赖...
echo.
pushd "%ROOT%"
where bun >nul 2>nul
if errorlevel 1 (
  echo Bun 未安装，尝试 npm...
  where npm >nul 2>nul
  if errorlevel 1 (
    echo [FAIL] bun 和 npm 均不可用。
    popd
    exit /b 1
  )
  npm install
) else (
  bun install
)
set "INSTALL_EXIT=%ERRORLEVEL%"
popd
if %INSTALL_EXIT% equ 0 (
  echo [OK] 依赖安装完成。
) else (
  echo [FAIL] 依赖安装失败。
)
exit /b %INSTALL_EXIT%


REM ================================================================
REM  5. 检查运行环境
REM ================================================================
:checkEnvAction
echo.
echo [环境检查] Environment Check
echo.
echo   --- Git ---
where git >nul 2>nul && echo     Git       : OK || echo     Git       : 未安装
echo.
echo   --- Node.js ---
where node >nul 2>nul && (
  for /f "tokens=*" %%v in ('node -v 2^>nul') do echo     Node.js   : %%v
) || echo     Node.js   : 未安装
echo.
echo   --- Bun ---
where bun >nul 2>nul && (
  for /f "tokens=*" %%v in ('bun -v 2^>nul') do echo     Bun       : %%v
) || echo     Bun       : 未安装
echo.
echo   --- Deno ---
where deno >nul 2>nul && (
  for /f "tokens=*" %%v in ('deno -V 2^>nul') do echo     Deno      : %%v
) || echo     Deno      : 未安装
echo.
echo   --- .env ---
if exist "%ENV_FILE%" (
  echo     .env      : 已存在
) else (
  echo     .env      : 缺失
)
echo.
echo   --- 服务状态 ---
call :pidRunning
if errorlevel 1 (
  echo     Service   : 已停止
) else (
  echo     Service   : 运行中 (PID: !SERVICE_PID!)
)
exit /b 0


REM ================================================================
REM  8. 启动服务 (后台)
REM ================================================================
:startAction
call :ensureEnv
if errorlevel 1 exit /b 1
call :detectRuntime

call :pidRunning
if not errorlevel 1 (
  echo [WARN] 服务已在运行，PID: !SERVICE_PID!
  exit /b 0
)

if not exist "%RUNTIME_DIR%" mkdir "%RUNTIME_DIR%"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

call :readPort

if /i "!RUNTIME!"=="bun" (
  where bun >nul 2>nul
  if errorlevel 1 (
    echo [FAIL] Bun 未安装。
    exit /b 1
  )
  echo 运行环境: Bun
  echo 入口文件: %BUN_MAIN%
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ErrorActionPreference='Stop';" ^
    "$env:PATH = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User');" ^
    "$p = Start-Process -FilePath 'bun' -ArgumentList @('run','--watch','%BUN_MAIN%') -WorkingDirectory '%ROOT%' -RedirectStandardOutput '%OUT_LOG%' -RedirectStandardError '%ERR_LOG%' -WindowStyle Hidden -PassThru;" ^
    "Set-Content -LiteralPath '%PID_FILE%' -Value $p.Id -Encoding ASCII;" ^
    "Write-Output ('PID: ' + $p.Id)"
  if errorlevel 1 (
    echo [FAIL] 启动失败。
    exit /b 1
  )
) else (
  where deno >nul 2>nul
  if errorlevel 1 (
    echo [FAIL] Deno 未安装。
    exit /b 1
  )
  echo 运行环境: Deno
  echo 入口文件: %DENO_MAIN%
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ErrorActionPreference='Stop';" ^
    "$env:PATH = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User');" ^
    "$p = Start-Process -FilePath 'deno' -ArgumentList @('run','--allow-net','--allow-env','--allow-read','%DENO_MAIN%') -WorkingDirectory '%ROOT%' -RedirectStandardOutput '%OUT_LOG%' -RedirectStandardError '%ERR_LOG%' -WindowStyle Hidden -PassThru;" ^
    "Set-Content -LiteralPath '%PID_FILE%' -Value $p.Id -Encoding ASCII;" ^
    "Write-Output ('PID: ' + $p.Id)"
  if errorlevel 1 (
    echo [FAIL] 启动失败。
    exit /b 1
  )
)

echo [OK] 服务已启动。
echo       API  : http://127.0.0.1:%PORT%
echo       日志 : %OUT_LOG%
exit /b 0


REM ================================================================
REM  9. 开发模式 (前台 + 热重载)
REM ================================================================
:devAction
call :ensureEnv
if errorlevel 1 exit /b 1
call :detectRuntime
call :readPort

if /i "!RUNTIME!"=="bun" (
  where bun >nul 2>nul
  if errorlevel 1 (
    echo [FAIL] Bun 未安装。
    exit /b 1
  )
  echo 开发模式 (Bun + watch)
  echo API: http://127.0.0.1:%PORT%
  echo 按 Ctrl+C 停止。
  echo.
  pushd "%ROOT%"
  bun run --watch "%BUN_MAIN%"
  set "DEV_EXIT=%ERRORLEVEL%"
  popd
) else (
  where deno >nul 2>nul
  if errorlevel 1 (
    echo [FAIL] Deno 未安装。
    exit /b 1
  )
  echo 开发模式 (Deno + watch)
  echo API: http://127.0.0.1:%PORT%
  echo 按 Ctrl+C 停止。
  echo.
  pushd "%ROOT%"
  deno run --allow-net --allow-env --allow-read --watch "%DENO_MAIN%"
  set "DEV_EXIT=%ERRORLEVEL%"
  popd
)
exit /b %DEV_EXIT%


REM ================================================================
REM  10. 停止服务
REM ================================================================
:stopAction
call :pidRunning
if errorlevel 1 (
  echo [INFO] 服务未在运行。
  if exist "%PID_FILE%" (
    echo        正在清除残留 PID 文件...
    del "%PID_FILE%"
  )
  exit /b 0
)
echo 正在停止服务，PID: !SERVICE_PID!
taskkill /PID !SERVICE_PID! /T /F >nul 2>nul
if errorlevel 1 (
  echo [FAIL] 停止服务失败。
  exit /b 1
)
if exist "%PID_FILE%" del "%PID_FILE%"
if exist "%RUNTIME_MODE_FILE%" del "%RUNTIME_MODE_FILE%"
echo [OK] 服务已停止。
exit /b 0


REM ================================================================
REM  11. 重启服务
REM ================================================================
:restartAction
echo.
echo [Restart] 重启服务...
call :stopAction
timeout /t 2 /nobreak >nul
call :startAction
exit /b %ERRORLEVEL%


REM ================================================================
REM  12. 服务状态
REM ================================================================
:statusAction
echo.
echo [Service Status] 服务状态:
call :readPort
echo   API 地址  : http://127.0.0.1:%PORT%
echo   PID 文件  : %PID_FILE%
call :detectRuntime
echo   运行环境  : !RUNTIME_LABEL!
echo.
call :pidRunning
if errorlevel 1 (
  echo   状态      : 已停止
  exit /b 1
) else (
  echo   状态      : 运行中
  echo   PID       : !SERVICE_PID!
)
exit /b 0


REM ================================================================
REM  13. 查看当前配置
REM ================================================================
:configAction
echo.
echo [Current Config] 当前配置:
if not exist "%ENV_FILE%" (
  echo [FAIL] .env 不存在: %ENV_FILE%
  echo        请运行: sider.bat init-config
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$keys=@('PORT','AUTH_TOKEN','SIDER_API_URL','SIDER_AUTH_TOKEN','DEEPSEEK_BASE_URL','DEEPSEEK_API_KEY','DEEPSEEK_MODEL','ANTHROPIC_BASE_URL','ANTHROPIC_API_KEY','DEFAULT_BACKEND','AUTO_FALLBACK','PREFER_SIDER_FOR_CHAT','DEBUG_ROUTING','REQUEST_TIMEOUT','LOG_LEVEL','NODE_ENV');" ^
  "$values=@{};" ^
  "Get-Content -LiteralPath '%ENV_FILE%' -Encoding UTF8 | ForEach-Object {" ^
  "  $line=$_.Trim();" ^
  "  if(!$line -or $line.StartsWith('#')){ return };" ^
  "  $idx=$line.IndexOf('=');" ^
  "  if($idx -le 0){ return };" ^
  "  $key=$line.Substring(0,$idx).Trim();" ^
  "  $value=$line.Substring($idx+1).Trim();" ^
  "  if($key){ $values[$key]=$value }" ^
  "};" ^
  "foreach($key in $keys){" ^
  "  $value=$values[$key];" ^
  "  if($null -eq $value){ $value='<unset>' }" ^
  "  elseif($key -match 'TOKEN|KEY'){" ^
  "    if($value.Length -le 8){ $value='********' }" ^
  "    else { $value=$value.Substring(0,4) + '...' + $value.Substring($value.Length-4) }" ^
  "  };" ^
  "  Write-Output ('  ' + $key + ' = ' + $value)" ^
  "}"
exit /b %ERRORLEVEL%


REM ================================================================
REM  14. 设置配置参数
REM ================================================================
:setConfigPrompt
echo.
echo [Set Config] 设置配置参数:
echo.
echo   常用参数:
echo     PORT                      服务端口 (默认: 4141)
echo     AUTH_TOKEN                客户端认证 Token
echo     SIDER_AUTH_TOKEN          Sider AI JWT Token
echo     DEEPSEEK_API_KEY          DeepSeek API Key
echo     DEEPSEEK_BASE_URL         DeepSeek 基础 URL
echo     DEEPSEEK_MODEL            DeepSeek 模型名
echo     DEFAULT_BACKEND           默认后端 (sider / deepseek)
echo     AUTO_FALLBACK             自动降级 (true / false)
echo     PREFER_SIDER_FOR_CHAT     对话优先 Sider (true / false)
echo     DEBUG_ROUTING             调试路由 (true / false)
echo     REQUEST_TIMEOUT           请求超时毫秒数
echo.
set /p "CFG_KEY=  参数名: "
if "%CFG_KEY%"=="" exit /b 1
set /p "CFG_VALUE=  参数值: "
call :setEnvValue "%CFG_KEY%" "%CFG_VALUE%"
exit /b %ERRORLEVEL%


REM ================================================================
REM  15. 切换运行环境 (Deno / Bun)
REM ================================================================
:switchRuntimeAction
echo.
echo [Switch Runtime] 切换运行环境:
call :detectRuntime
echo   当前: !RUNTIME_LABEL!
echo.
echo   1. Deno (默认)
echo   2. Bun
echo.
set /p "RT_CHOICE=  请选择 [1/2]: "
if "%RT_CHOICE%"=="1" (
  echo deno> "%RUNTIME_MODE_FILE%"
  echo [OK] 已切换到 Deno。
) else if "%RT_CHOICE%"=="2" (
  echo bun> "%RUNTIME_MODE_FILE%"
  echo [OK] 已切换到 Bun。
) else (
  echo [INFO] 未更改。
)
exit /b 0


REM ================================================================
REM  16. 健康检查
REM ================================================================
:healthAction
call :readPort
echo.
echo [Health Check] 健康检查: http://127.0.0.1:%PORT%/health
where curl.exe >nul 2>nul
if errorlevel 1 (
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "try { $r=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:%PORT%/health' -TimeoutSec 10; Write-Output $r.Content; Write-Output ('Status: ' + $r.StatusCode) } catch { Write-Output ('FAIL: ' + $_.Exception.Message) }"
) else (
  curl.exe -fsS --connect-timeout 10 "http://127.0.0.1:%PORT%/health" 2>&1
)
exit /b %ERRORLEVEL%


REM ================================================================
REM  17. 查看日志
REM ================================================================
:logsAction
echo.
echo [Recent Logs] 最近日志:
if not exist "%LOG_DIR%" (
  echo [INFO] 日志目录不存在: %LOG_DIR%
  exit /b 1
)
echo --- stdout (最近 80 行) ---
if exist "%OUT_LOG%" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Content -LiteralPath '%OUT_LOG%' -Tail 80"
) else (
  echo   (无)
)
echo.
echo --- stderr (最近 80 行) ---
if exist "%ERR_LOG%" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Content -LiteralPath '%ERR_LOG%' -Tail 80"
) else (
  echo   (无)
)
exit /b 0


REM ================================================================
REM  18. 运行回归测试
REM ================================================================
:testAction
echo.
echo [Regression Tests] 回归测试:
echo.
echo --- Deno tests ---
where deno >nul 2>nul
if errorlevel 1 (
  echo [SKIP] Deno 未安装，跳过。
) else (
  pushd "%ROOT%"
  deno test --allow-env deno/test
  set "DT_EXIT=%ERRORLEVEL%"
  popd
  if !DT_EXIT! equ 0 (echo [OK] Deno 测试通过。) else (echo [FAIL] Deno 测试失败。)
)

echo.
echo --- Deno type check ---
where deno >nul 2>nul
if errorlevel 1 (
  echo [SKIP] Deno 未安装，跳过。
) else (
  pushd "%ROOT%"
  deno check deno/main.ts
  set "DC_EXIT=%ERRORLEVEL%"
  popd
  if !DC_EXIT! equ 0 (echo [OK] Deno 类型检查通过。) else (echo [FAIL] Deno 类型检查失败。)
)

echo.
echo --- TypeScript type check ---
where npm >nul 2>nul
if errorlevel 1 (
  echo [SKIP] npm 未安装，跳过。
) else (
  pushd "%ROOT%"
  npm run typecheck
  set "TC_EXIT=%ERRORLEVEL%"
  popd
  if !TC_EXIT! equ 0 (echo [OK] TypeScript 类型检查通过。) else (echo [FAIL] TypeScript 类型检查失败。)
)
exit /b 0


REM ================================================================
REM  19. 类型检查
REM ================================================================
:typecheckAction
echo.
echo [Type Checks] 类型检查:
echo.
echo --- Deno ---
pushd "%ROOT%"
where deno >nul 2>nul
if errorlevel 1 (
  echo [SKIP] Deno 未安装，跳过。
) else (
  deno check deno/main.ts
)
echo.
echo --- TypeScript (tsc) ---
where npm >nul 2>nul
if errorlevel 1 (
  echo [SKIP] npm 未安装，跳过。
) else (
  npm run typecheck
)
popd
exit /b 0


REM ================================================================
REM  20. 清理缓存和构建产物
REM ================================================================
:cleanAction
echo.
echo [Clean] 清理:
echo.
echo 将清理以下内容:
echo   - dist/        (TypeScript 构建输出)
echo   - .runtime/    (PID 文件)
echo   - logs/        (运行日志)
echo   - deno.lock    (Deno 锁文件)
echo.
set /p "CLEAN_CONFIRM=确认清理? [y/N] "
if /i not "%CLEAN_CONFIRM%"=="y" (
  echo 已取消。
  exit /b 0
)

pushd "%ROOT%"
if exist "dist" (
  rmdir /s /q "dist" 2>nul
  echo [OK] 已删除 dist/
)
if exist ".runtime" (
  rmdir /s /q ".runtime" 2>nul
  echo [OK] 已删除 .runtime/
)
if exist "logs" (
  rmdir /s /q "logs" 2>nul
  echo [OK] 已删除 logs/
)
if exist "deno.lock" (
  del "deno.lock" 2>nul
  echo [OK] 已删除 deno.lock
)
popd
echo [OK] 清理完成。
exit /b 0


REM ================================================================
REM  21. 导出 cc-switch 配置 (Export cc-switch config)
REM ================================================================
:ccSwitchExportAction
echo.
echo [cc-switch Export] 导出 cc-switch 配置:
echo.
echo 从 .env 读取 Sider2Claude 配置，生成 cc-switch 兼容的提供者 JSON。

REM Sanity-check: Python (Anaconda) must exist
set "PYTHON_EXE=C:\Users\PC\anaconda3\envs\python312\python.exe"
if not exist "%PYTHON_EXE%" (
  echo [FAIL] 未找到 Python: %PYTHON_EXE%
  echo        请检查 Anaconda 环境路径。
  exit /b 1
)

%PYTHON_EXE% "%ROOT%\tools\export-cc-switch.py" --env-file "%ENV_FILE%" --output "%ROOT%\cc-switch-provider.json" --deeplink

if %ERRORLEVEL% equ 0 (
  echo.
  echo [OK] cc-switch 配置已导出。
  echo.
  REM Deep link sidecar file
  set "CC_DL_FILE=%ROOT%\cc-switch-provider.deeplink.url"
  if exist "!CC_DL_FILE!" (
    echo 正在唤起 cc-switch 导入...
    REM Use PowerShell to read and open the URL (avoids cmd parsing & in URL)
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
      "$url = Get-Content -LiteralPath '!CC_DL_FILE!' -Raw; Start-Process $url.Trim()"
    echo [OK] 已向 cc-switch 发送导入请求。
    echo      如果 cc-switch 未弹出，请手动导入 JSON 文件:
    echo      !CC_DL_FILE!
  ) else (
    echo [INFO] 无法生成 deep link，请手动导入:
    echo       cc-switch ^> Settings ^> Import/Export ^> Import providers
  )
) else (
  echo [FAIL] 导出失败，请检查 .env 配置和 Python 环境。
)
exit /b %ERRORLEVEL%
)
exit /b %ERRORLEVEL%


REM ================================================================
REM  UTILITY FUNCTIONS (工具函数)
REM ================================================================

REM --- ensureGit ---
:ensureGit
where git >nul 2>nul
if errorlevel 1 (
  echo [FAIL] Git 未安装或不在 PATH 中。
  echo        Install: https://git-scm.com/
  exit /b 1
)
exit /b 0

REM --- ensureDeno ---
:ensureDeno
where deno >nul 2>nul
if errorlevel 1 (
  echo [FAIL] Deno 未安装或不在 PATH 中。
  echo        Install: irm https://deno.land/install.ps1 ^| iex
  exit /b 1
)
exit /b 0

REM --- ensureBun ---
:ensureBun
where bun >nul 2>nul
if errorlevel 1 (
  echo [FAIL] Bun 未安装或不在 PATH 中。
  echo        Install: powershell -c "irm bun.sh/install.ps1 | iex"
  exit /b 1
)
exit /b 0

REM --- ensureNpm ---
:ensureNpm
where npm >nul 2>nul
if errorlevel 1 (
  echo [FAIL] npm 未安装或不在 PATH 中。
  exit /b 1
)
exit /b 0

REM --- ensureEnv ---
:ensureEnv
if exist "%ENV_FILE%" exit /b 0
echo [WARN] .env 不存在。
call :initConfigAction
exit /b %ERRORLEVEL%

REM --- initConfigAction ---
:initConfigAction
if exist "%ENV_FILE%" (
  echo .env 已存在: %ENV_FILE%
  exit /b 0
)
if exist "%ENV_EXAMPLE%" (
  copy "%ENV_EXAMPLE%" "%ENV_FILE%" >nul
  echo [OK] 已从 deno\.env.example 创建 .env
  echo [WARN] 请编辑 .env 填入必要 Token 后再启动服务。
  exit /b 0
)
(
  echo PORT=4141
  echo AUTH_TOKEN=your-client-token
  echo SIDER_API_URL=https://sider.ai/api/chat/v1/completions
  echo SIDER_AUTH_TOKEN=
  echo DEEPSEEK_BASE_URL=https://api.deepseek.com/anthropic
  echo DEEPSEEK_API_KEY=
  echo DEEPSEEK_MODEL=deepseek-v4-flash
  echo DEFAULT_BACKEND=sider
  echo AUTO_FALLBACK=true
  echo PREFER_SIDER_FOR_CHAT=true
  echo DEBUG_ROUTING=false
  echo REQUEST_TIMEOUT=30000
) > "%ENV_FILE%"
echo [OK] 已创建最小 .env。
exit /b 0

REM --- editConfigAction ---
:editConfigAction
call :ensureEnv
if errorlevel 1 exit /b 1
start "" notepad "%ENV_FILE%"
exit /b 0

REM --- readPort ---
:readPort
set "PORT=8000"
if not exist "%ENV_FILE%" exit /b 0
for /f "usebackq tokens=1,* delims==" %%A in (`findstr /B /C:"PORT=" "%ENV_FILE%" 2^>nul`) do set "PORT=%%B"
set "PORT=%PORT:"=%"
set "PORT=%PORT:'=%"
exit /b 0

REM --- setEnvValue ---
REM Usage: call :setEnvValue "KEY" "VALUE"
:setEnvValue
call :ensureEnv
if errorlevel 1 exit /b 1
set "CFG_KEY=%~1"
set "CFG_VALUE=%~2"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "$path='%ENV_FILE%';" ^
  "$key='%CFG_KEY%';" ^
  "$value='%CFG_VALUE%';" ^
  "if(!(Test-Path -LiteralPath $path)){ New-Item -ItemType File -Path $path | Out-Null };" ^
  "$lines=@(Get-Content -LiteralPath $path -ErrorAction SilentlyContinue);" ^
  "$pattern='^\s*' + [regex]::Escape($key) + '\s*=';" ^
  "$entry=$key + '=' + $value;" ^
  "$found=$false;" ^
  "$next=@();" ^
  "foreach($line in $lines){" ^
  "  if($line -match $pattern){" ^
  "    if(!$found){ $next += $entry; $found=$true }" ^
  "  } else { $next += $line }" ^
  "};" ^
  "if(!$found){ $next += $entry };" ^
  "Set-Content -LiteralPath $path -Value $next -Encoding UTF8"
if errorlevel 1 (
  echo [FAIL] 更新 .env 失败。
  exit /b 1
)
echo [OK] 已设置 %CFG_KEY% = %CFG_VALUE%
exit /b 0

REM --- detectRuntime ---
:detectRuntime
set "RUNTIME=deno"
set "RUNTIME_LABEL=Deno (default)"
if not exist "%RUNTIME_MODE_FILE%" exit /b 0
set /p "RT_MODE_RAW="<"%RUNTIME_MODE_FILE%" 2>nul
for /f "tokens=1" %%X in ("!RT_MODE_RAW!") do set "RUNTIME_MODE=%%X"
if /i "!RUNTIME_MODE!"=="bun" (
  set "RUNTIME=bun"
  set "RUNTIME_LABEL=Bun"
) else if /i "!RUNTIME_MODE!"=="deno" (
  set "RUNTIME=deno"
  set "RUNTIME_LABEL=Deno"
)
exit /b 0

REM --- pidRunning ---
REM Returns errorlevel 0 if running, 1 if not
:pidRunning
set "SERVICE_PID="
if not exist "%PID_FILE%" exit /b 1
set /p "SERVICE_PID="<"%PID_FILE%"
if "!SERVICE_PID!"=="" exit /b 1
tasklist /FI "PID eq !SERVICE_PID!" /NH 2>nul | findstr /I /C:"deno.exe" /C:"bun.exe" >nul
if errorlevel 1 exit /b 1
exit /b 0
