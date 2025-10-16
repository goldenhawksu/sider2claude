# PowerShell 脚本：准备 Deno Deploy 部署
# 将 Bun/Node.js 代码转换为 Deno 兼容版本

Write-Host "🔄 开始准备 Deno Deploy 部署..." -ForegroundColor Cyan
Write-Host ""

# 1. 复制源文件
Write-Host "📋 步骤 1: 复制源文件..." -ForegroundColor Yellow

$folders = @("types", "middleware", "utils", "routes")
foreach ($folder in $folders) {
    $src = "src\$folder"
    $dest = "deno\src\$folder"

    if (Test-Path $src) {
        Write-Host "  复制 $src -> $dest"
        Copy-Item -Path $src -Destination $dest -Recurse -Force
    }
}

Write-Host "✅ 源文件复制完成`n" -ForegroundColor Green

# 2. 修改导入语句（添加 .ts 后缀）
Write-Host "📦 步骤 2: 修改导入语句..." -ForegroundColor Yellow

$files = Get-ChildItem -Path "deno\src" -Filter "*.ts" -Recurse

foreach ($file in $files) {
    $content = Get-Content $file.FullName -Raw

    # 修改相对导入（添加 .ts 后缀）
    $content = $content -replace "from '\.\/(.*?)(?<!\.ts)'", "from './$1.ts'"
    $content = $content -replace 'from "\.\/(.*?)(?<!\.ts)"', 'from "./$1.ts"'
    $content = $content -replace "from '\.\./(.*?)(?<!\.ts)'", "from '../$1.ts'"
    $content = $content -replace 'from "\.\./(.*?)(?<!\.ts)"', 'from "../$1.ts"'

    # 保存修改
    Set-Content -Path $file.FullName -Value $content -NoNewline

    Write-Host "  ✓ $($file.Name)"
}

Write-Host "✅ 导入语句修改完成`n" -ForegroundColor Green

# 3. 替换环境变量访问
Write-Host "🔧 步骤 3: 替换环境变量访问..." -ForegroundColor Yellow

foreach ($file in $files) {
    $content = Get-Content $file.FullName -Raw

    # 替换 process.env.VAR_NAME 为 Deno.env.get('VAR_NAME')
    $content = $content -replace 'process\.env\.([A-Z_]+)', 'Deno.env.get("$1")'

    # 保存修改
    Set-Content -Path $file.FullName -Value $content -NoNewline

    Write-Host "  ✓ $($file.Name)"
}

Write-Host "✅ 环境变量访问替换完成`n" -ForegroundColor Green

# 4. 修改特定的导入（consola）
Write-Host "🔄 步骤 4: 处理特殊依赖..." -ForegroundColor Yellow

foreach ($file in $files) {
    $content = Get-Content $file.FullName -Raw

    # 某些文件可能需要替换 consola 日志为 console
    $content = $content -replace 'consola\.info', 'console.log'
    $content = $content -replace 'consola\.error', 'console.error'
    $content = $content -replace 'consola\.warn', 'console.warn'
    $content = $content -replace 'consola\.debug', 'console.debug'

    # 移除 consola 导入
    $content = $content -replace "import.*consola.*\r?\n", ""

    # 保存修改
    Set-Content -Path $file.FullName -Value $content -NoNewline
}

Write-Host "✅ 特殊依赖处理完成`n" -ForegroundColor Green

# 5. 验证
Write-Host "🔍 步骤 5: 验证文件..." -ForegroundColor Yellow

$denoFiles = Get-ChildItem -Path "deno\src" -Filter "*.ts" -Recurse
Write-Host "  总共转换了 $($denoFiles.Count) 个文件"

Write-Host "`n✅ 所有步骤完成！`n" -ForegroundColor Green

# 6. 下一步提示
Write-Host "📝 接下来的步骤:" -ForegroundColor Cyan
Write-Host "  1. 检查 deno/src 目录中的文件"
Write-Host "  2. 运行本地测试: deno task dev"
Write-Host "  3. 如果测试通过，部署到 Deno Deploy"
Write-Host ""
Write-Host "🚀 部署命令:" -ForegroundColor Cyan
Write-Host "  deployctl deploy --project=sider2claude deno/main.ts"
Write-Host ""
