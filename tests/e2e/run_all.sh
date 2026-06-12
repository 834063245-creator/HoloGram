#!/bin/bash
# 端到端测试入口
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PASS=0
FAIL=0

echo "=== HoloGram E2E Tests ==="
echo ""

for test_script in "$SCRIPT_DIR"/test_*.sh; do
    name=$(basename "$test_script")
    echo -n "  $name ... "
    if bash "$test_script"; then
        PASS=$((PASS + 1))
    else
        FAIL=$((FAIL + 1))
        echo "FAIL (exit code $?)"
    fi
done

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [ $FAIL -gt 0 ]; then
    exit 1
fi
