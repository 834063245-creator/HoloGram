#!/bin/bash
# prebuild.sh — build frontend for Tauri bundling
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT="$(cd "$SCRIPT_DIR/.." && pwd)"
echo "[prebuild] building frontend..."
cd "$PROJECT/src-ui" && npm run build
echo "[prebuild] done"
