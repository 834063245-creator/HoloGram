#!/bin/bash
# ============================================================
# HoloGram 一键构建
#   ./build.sh           编译引擎 + 桌面应用
#   ./build.sh engine    只编译引擎
#   ./build.sh app       只打桌面安装包
# ============================================================
set -e
cd "$(dirname "$0")/.."

# Platform-adaptive binary name: hologram-engine on Linux, hologram-engine.exe on Windows
if [[ "$OS" == "Windows_NT" ]] || [[ "$(uname -s)" == MINGW* ]] || [[ "$(uname -s)" == CYGWIN* ]]; then
    ENGINE_BIN="hologram-engine.exe"
else
    ENGINE_BIN="hologram-engine"
fi

build_engine() {
    echo "═══ 编译引擎 ═══"
    cd engine && cargo build --release && cd ..
    mkdir -p engine-bin
    cp -f "engine/target/release/$ENGINE_BIN" "engine-bin/$ENGINE_BIN"
    echo "  ✓ engine-bin/$ENGINE_BIN"
}

build_app() {
    echo "═══ 编译桌面应用 ═══"
    cd src-ui && npm run build && cd ..
    cd src-tauri && cargo tauri build && cd ..
    echo "  ✓ src-tauri/target/release/bundle/msi/*.msi"
}

case "${1:-all}" in
    engine) build_engine ;;
    app)    build_app ;;
    all)    build_engine && build_app ;;
    *)      echo "用法: ./build.sh [engine|app|all]" ;;
esac
