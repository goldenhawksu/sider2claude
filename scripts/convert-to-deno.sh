#!/bin/bash

# 将 Bun 版本的代码转换为 Deno 兼容版本

echo "🔄 开始转换代码到 Deno 兼容版本..."

# 创建目录
mkdir -p deno/src/{types,routes,middleware,utils}

# 复制类型定义（无需修改）
echo "📋 复制类型定义..."
cp src/types/anthropic.ts deno/src/types/
cp src/types/sider.ts deno/src/types/
cp src/types/index.ts deno/src/types/

# 复制工具文件并适配
echo "🔧 转换工具文件..."

# 转换 request-converter.ts
sed 's/process\.env\./Deno.env.get("/g; s/\bfrom '\''consola'\''/from "npm:consola@3.2.3"/g' \
  src/utils/request-converter.ts | \
  sed 's/import invariant from '\''tiny-invariant'\''/import invariant from "npm:tiny-invariant@1.3.3"/g' | \
  sed 's/from '\''\.\/env'\''/from "..\/utils\/env.ts"/g' \
  > deno/src/utils/request-converter.ts

# 转换 response-converter.ts
sed 's/process\.env\./Deno.env.get("/g' \
  src/utils/response-converter.ts | \
  sed 's/from '\''\.\//from ".\//g; s/'\'';$/.ts'\'';\n/g' \
  > deno/src/utils/response-converter.ts

# 转换 sider-client.ts
sed 's/process\.env\./Deno.env.get("/g' \
  src/utils/sider-client.ts | \
  sed 's/from '\''fetch-event-stream'\''/from "npm:fetch-event-stream@1.0.0"/g' | \
  sed 's/from '\''\.\//from ".\//g; s/'\'';$/.ts'\'';\n/g' \
  > deno/src/utils/sider-client.ts

# 转换其他工具文件
for file in src/utils/*.ts; do
  filename=$(basename "$file")
  if [ "$filename" != "env.ts" ] && [ "$filename" != "request-converter.ts" ] && \
     [ "$filename" != "response-converter.ts" ] && [ "$filename" != "sider-client.ts" ]; then
    echo "  转换 $filename..."
    sed 's/process\.env\./Deno.env.get("/g' "$file" | \
      sed 's/from '\''\.\//from ".\//g; s/'\''$/\.ts'\''/g' \
      > "deno/src/utils/$filename"
  fi
done

# 转换中间件
echo "🔐 转换中间件..."
cp src/middleware/auth.ts deno/src/middleware/auth.ts
sed -i 's/process\.env\./Deno.env.get("/g' deno/src/middleware/auth.ts

# 转换路由
echo "🛣️  转换路由..."
for file in src/routes/*.ts; do
  filename=$(basename "$file")
  echo "  转换路由 $filename..."
  sed 's/process\.env\./Deno.env.get("/g' "$file" | \
    sed 's/from '\''hono'\''/from "hono"/g' | \
    sed 's/from '\''\.\.\/utils\//from "..\/utils\//g; s/'\''$/\.ts'\''/g' | \
    sed 's/from '\''\.\.\/middleware\//from "..\/middleware\//g' | \
    sed 's/from '\''\.\.\/types\//from "..\/types\//g' \
    > "deno/src/routes/$filename"
done

echo "✅ 转换完成！"
echo ""
echo "📝 接下来的步骤:"
echo "1. 检查 deno/src/ 目录中的文件"
echo "2. 手动调整导入路径（添加 .ts 后缀）"
echo "3. 运行: deno task dev"
echo "4. 测试: deno task test"
