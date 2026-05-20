#!/bin/bash
# 兼容入口：委托给统一服务级集成测试 runner。
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

case "${1:-all}" in
  all)
    bun run test/run-all-tests.ts
    ;;
  1)
    bun run test/run-all-tests.ts 01-health-check.test.ts
    ;;
  2)
    bun run test/run-all-tests.ts 02-basic-messages.test.ts
    ;;
  3)
    bun run test/run-all-tests.ts 03-session-persistence.test.ts
    ;;
  4)
    bun run test/run-all-tests.ts 04-streaming.test.ts
    ;;
  5)
    bun run test/run-all-tests.ts 05-token-counting.test.ts
    ;;
  *)
    bun run test/run-all-tests.ts "$@"
    ;;
esac
