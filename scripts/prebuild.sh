#!/bin/bash
# prebuild.sh — 构建前准备：同步 src_python 到嵌入式 Python + 编译前端
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT="$(cd "$SCRIPT_DIR/.." && pwd)"

# 1) sync src_python into embedded Python site-packages
echo "[prebuild] syncing src_python..."
rm -rf "$PROJECT/src-tauri/python/Lib/site-packages/src_python"
cp -r "$PROJECT/src_python" "$PROJECT/src-tauri/python/Lib/site-packages/src_python"
# clean pycache noise
find "$PROJECT/src-tauri/python/Lib/site-packages/src_python" -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
find "$PROJECT/src-tauri/python/Lib/site-packages/src_python" -type f -name "*.pyc" -delete 2>/dev/null || true
echo "[prebuild] src_python synced"

# 2) build frontend
echo "[prebuild] building frontend..."
cd "$PROJECT/src-ui" && npm run build
echo "[prebuild] done"
