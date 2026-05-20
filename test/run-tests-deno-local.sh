#!/bin/bash
# 测试 Deno 本地服务器 (localhost:8000)
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "========================================"
echo "测试 Deno 本地服务器"
echo "环境: deno-local"
echo "API: http://localhost:8000"
echo "========================================"
echo

export TEST_ENV=deno-local
bun run test/run-all-tests.ts
