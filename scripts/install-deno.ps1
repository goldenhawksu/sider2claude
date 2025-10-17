#!/usr/bin/env pwsh
# Deno 安装脚本 (Windows PowerShell)

Write-Host "🦕 Deno 安装脚本" -ForegroundColor Cyan
Write-Host "=" * 60
Write-Host ""

# 检查是否已安装
if (Get-Command deno -ErrorAction SilentlyContinue) {
    Write-Host "✅ Deno 已安装!" -ForegroundColor Green
    Write-Host ""
    deno --version
    Write-Host ""

    $response = Read-Host "是否要重新安装? (y/N)"
    if ($response -ne 'y' -and $response -ne 'Y') {
        Write-Host "跳过安装" -ForegroundColor Yellow
        exit 0
    }
}

Write-Host "📥 开始安装 Deno..." -ForegroundColor Cyan
Write-Host ""

try {
    # 使用官方安装脚本
    irm https://deno.land/install.ps1 | iex

    Write-Host ""
    Write-Host "✅ Deno 安装成功!" -ForegroundColor Green
    Write-Host ""

    # 刷新环境变量
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

    # 验证安装
    if (Get-Command deno -ErrorAction SilentlyContinue) {
        Write-Host "🎉 验证成功:" -ForegroundColor Green
        deno --version
        Write-Host ""

        Write-Host "📖 下一步:" -ForegroundColor Cyan
        Write-Host "  1. 重启终端以刷新环境变量" -ForegroundColor White
        Write-Host "  2. 运行: cd deno" -ForegroundColor White
        Write-Host "  3. 运行: .\start-local.bat" -ForegroundColor White
        Write-Host ""
    } else {
        Write-Host "⚠️ 安装完成但未检测到 deno 命令" -ForegroundColor Yellow
        Write-Host "请重启终端后再试" -ForegroundColor Yellow
    }

} catch {
    Write-Host "❌ 安装失败: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
    Write-Host "请尝试手动安装:" -ForegroundColor Yellow
    Write-Host "  PowerShell: irm https://deno.land/install.ps1 | iex" -ForegroundColor White
    Write-Host "  Scoop: scoop install deno" -ForegroundColor White
    Write-Host "  Chocolatey: choco install deno" -ForegroundColor White
    Write-Host ""
    exit 1
}

Write-Host "按任意键退出..." -ForegroundColor Gray
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
