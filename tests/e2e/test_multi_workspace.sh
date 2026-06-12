#!/bin/bash
# 端到端: 多工作区隔离
set -euo pipefail

A=$(mktemp -d)
B=$(mktemp -d)
trap "rm -rf $A $B" EXIT

# 创建两个不同的项目
echo "def func_a(): pass" > "$A/a.py"
echo "def func_b(): pass" > "$B/b.py"

# 分析
python -m src_python "$A" 2>/dev/null
python -m src_python "$B" 2>/dev/null

# 验证 A 的图不含 func_b
if grep -q "func_b" "$A/hologram_graph.json"; then
    echo "FAIL: A 的图包含 B 的符号"
    exit 1
fi

# 验证 B 的图不含 func_a
if grep -q "func_a" "$B/hologram_graph.json"; then
    echo "FAIL: B 的图包含 A 的符号"
    exit 1
fi

# 验证两个文件不同
if diff -q "$A/hologram_graph.json" "$B/hologram_graph.json" > /dev/null 2>&1; then
    echo "FAIL: 两个不同项目的图文件内容相同"
    exit 1
fi

echo "PASS: 多工作区隔离"
