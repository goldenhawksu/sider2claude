#!/bin/bash
# 测试 Deno Deploy 生产环境
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "========================================"
echo "测试 Deno Deploy 生产环境"
echo "环境: deno-deploy"
echo "API: 由 TEST_API_BASE_URL 或 DENO_DEPLOY_URL 指定"
echo "========================================"
echo

export TEST_ENV=deno-deploy
bun run test/run-all-tests.ts
