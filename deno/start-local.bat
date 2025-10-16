@echo off
echo 🦕 启动 Deno 本地测试服务器...
echo.

cd /d %~dp0

REM 检查是否安装 Deno
where deno >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo ❌ 错误: Deno 未安装
    echo.
    echo 请使用以下命令安装 Deno:
    echo   PowerShell: irm https://deno.land/install.ps1 ^| iex
    echo   Scoop: scoop install deno
    echo   Chocolatey: choco install deno
    echo.
    pause
    exit /b 1
)

echo ✅ Deno 版本:
deno --version
echo.

REM 检查 .env 文件
if not exist ".env" (
    echo ⚠️ 警告: .env 文件不存在
    echo 正在从 .env.example 复制...
    if exist ".env.example" (
        copy .env.example .env
        echo ✅ 已创建 .env 文件,请编辑并添加 SIDER_AUTH_TOKEN
        pause
        exit /b 1
    ) else (
        echo ❌ 提示: 请创建 .env 文件并配置 SIDER_AUTH_TOKEN
        echo.
    )
)

echo 🚀 启动服务器 (端口: 4142)...
echo 📋 Health check: http://localhost:4142/health
echo 📖 API info: http://localhost:4142/
echo 🔧 Models API: http://localhost:4142/v1/models
echo.
echo 按 Ctrl+C 停止服务器
echo.

deno run --allow-net --allow-env --allow-read --watch main.ts

pause
