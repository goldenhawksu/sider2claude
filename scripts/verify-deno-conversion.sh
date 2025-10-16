#!/bin/bash

# 验证 Deno 代码转换质量
# 检查常见问题和遗漏

echo "🔍 Deno 代码转换验证工具"
echo "========================================"
echo ""

# 计数器
errors=0
warnings=0

# 1. 检查导入语句是否都有 .ts 后缀
echo "📦 检查 1: 验证导入语句扩展名..."
missing_ext=$(find deno/src -name "*.ts" -type f -exec grep -H "from ['\"]\.\.*/[^'\"]*['\"]" {} \; | grep -v "\.ts['\"]" | grep -v "npm:")
if [ -n "$missing_ext" ]; then
  echo "  ❌ 发现缺少 .ts 扩展名的导入:"
  echo "$missing_ext"
  ((errors++))
else
  echo "  ✅ 所有相对导入都有 .ts 扩展名"
fi
echo ""

# 2. 检查是否还有 process.env 引用
echo "🌍 检查 2: 验证环境变量访问..."
process_env=$(find deno/src -name "*.ts" -type f -exec grep -H "process\.env\." {} \;)
if [ -n "$process_env" ]; then
  echo "  ⚠️  发现 process.env 引用 (可能需要手动检查):"
  echo "$process_env"
  ((warnings++))
else
  echo "  ✅ 没有发现 process.env 引用"
fi
echo ""

# 3. 检查是否还有 consola 导入
echo "📝 检查 3: 验证日志库..."
consola_imports=$(find deno/src -name "*.ts" -type f -exec grep -H "import.*consola" {} \;)
if [ -n "$consola_imports" ]; then
  echo "  ❌ 发现 consola 导入:"
  echo "$consola_imports"
  ((errors++))
else
  echo "  ✅ 没有 consola 导入"
fi
echo ""

# 4. 检查是否有错误的扩展名
echo "🔧 检查 4: 验证扩展名格式..."
wrong_ext=$(find deno/src -name "*.ts" -type f -exec grep -H "\.js\.ts\|\.ts\.ts" {} \;)
if [ -n "$wrong_ext" ]; then
  echo "  ❌ 发现错误的扩展名:"
  echo "$wrong_ext"
  ((errors++))
else
  echo "  ✅ 扩展名格式正确"
fi
echo ""

# 5. 统计转换文件数
echo "📊 检查 5: 统计转换文件..."
file_count=$(find deno/src -name "*.ts" -type f | wc -l)
echo "  📄 转换文件总数: $file_count"
echo ""

# 6. 检查关键文件是否存在
echo "📁 检查 6: 验证关键文件..."
critical_files=(
  "deno/main.ts"
  "deno.json"
  "deno/src/routes/messages.ts"
  "deno/src/utils/sider-client.ts"
  "deno/src/utils/request-converter.ts"
  "deno/src/utils/response-converter.ts"
  "deno/src/middleware/auth.ts"
)

for file in "${critical_files[@]}"; do
  if [ -f "$file" ]; then
    echo "  ✅ $file"
  else
    echo "  ❌ 缺失: $file"
    ((errors++))
  fi
done
echo ""

# 7. 检查 main.ts 导出格式
echo "🚀 检查 7: 验证 Deno Deploy 导出..."
export_check=$(grep -A1 "export default" deno/main.ts | grep -c "fetch: app.fetch")
if [ "$export_check" -gt 0 ]; then
  echo "  ✅ Deno Deploy 导出格式正确"
else
  echo "  ⚠️  Deno Deploy 导出格式可能不正确"
  ((warnings++))
fi
echo ""

# 8. 检查是否使用 Deno.env.get
echo "🔐 检查 8: 验证 Deno 环境变量..."
deno_env=$(grep -r "Deno\.env\.get" deno/main.ts)
if [ -n "$deno_env" ]; then
  echo "  ✅ 使用 Deno.env.get() 访问环境变量"
else
  echo "  ❌ main.ts 未使用 Deno.env.get()"
  ((errors++))
fi
echo ""

# 总结
echo "========================================"
echo "📋 验证总结"
echo "========================================"
echo ""
echo "  转换文件数: $file_count"
echo "  错误数: $errors"
echo "  警告数: $warnings"
echo ""

if [ $errors -eq 0 ] && [ $warnings -eq 0 ]; then
  echo "🎉 完美！代码转换质量优秀，可以部署到 Deno Deploy"
  exit 0
elif [ $errors -eq 0 ]; then
  echo "✅ 良好！代码转换完成，有 $warnings 个警告需要关注"
  exit 0
else
  echo "⚠️  发现 $errors 个错误，请修复后再部署"
  exit 1
fi
