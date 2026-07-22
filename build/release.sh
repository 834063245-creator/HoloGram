#!/bin/bash
# ============================================================
# HoloGram Release Builder (本地构建，用于快速发布)
# 本地构建 → 拷贝二进制 + CLI 脚本到 release-bin/ → 可选 gh CLI 发版
#
# CI (release.yml) 是正式发布路径，此脚本用于本地快速打包。
# ============================================================

set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RELEASE_DIR="$ROOT/release-bin"

# Platform-adaptive binary name
if [[ "$OS" == "Windows_NT" ]] || [[ "$(uname -s)" == MINGW* ]] || [[ "$(uname -s)" == CYGWIN* ]]; then
    ENGINE_BIN="hologram-engine.exe"
else
    ENGINE_BIN="hologram-engine"
fi

echo "=========================================="
echo " HoloGram Release Builder"
echo "=========================================="

# ── Step 1: Build Engine (via build.sh) ──
echo ""
echo "[1/3] Building hologram-engine..."
./build/build.sh engine
echo "  ✓ engine-bin/$ENGINE_BIN"

# ── Step 2: Copy binary + CLI wrappers to release-bin/ ──
echo ""
echo "[2/3] Copying binary + CLI wrappers to release-bin/..."
mkdir -p "$RELEASE_DIR"
cp -f "engine-bin/$ENGINE_BIN" "$RELEASE_DIR/"
cp -f release-bin/hologram "$RELEASE_DIR/hologram"
cp -f release-bin/hologram.cmd "$RELEASE_DIR/hologram.cmd"
cp -f release-bin/install.sh "$RELEASE_DIR/install.sh"
cp -f release-bin/install.cmd "$RELEASE_DIR/install.cmd"
chmod +x "$RELEASE_DIR/hologram" "$RELEASE_DIR/install.sh"
echo "  ✓ release-bin/$ENGINE_BIN"
echo "  ✓ release-bin/hologram (bash wrapper)"
echo "  ✓ release-bin/hologram.cmd (Windows wrapper)"
echo "  ✓ release-bin/install.sh (Linux/macOS installer)"
echo "  ✓ release-bin/install.cmd (Windows installer)"
ls -lh "$RELEASE_DIR/"

# ── Step 3: Push or Release ──
echo ""
echo "[3/3] Ready to ship."

# check for gh CLI
if command -v gh &> /dev/null && gh auth status &> /dev/null 2>&1; then
    echo ""
    read -p "Create GitHub Release now? (y/n): " yn
    if [ "$yn" = "y" ] || [ "$yn" = "Y" ]; then
        read -p "Version tag (e.g. v4.1.0): " VERSION
        read -p "Release notes: " NOTES
        gh release create "${VERSION}" \
            --title "HoloGram ${VERSION}" \
            --notes "${NOTES:-Release ${VERSION}}" \
            --draft \
            "$RELEASE_DIR/$ENGINE_BIN#HoloGram Engine (MCP Server)" \
            "$RELEASE_DIR/hologram#HoloGram CLI (bash wrapper)" \
            "$RELEASE_DIR/hologram.cmd#HoloGram CLI (Windows wrapper)" \
            "$RELEASE_DIR/install.sh#HoloGram CLI Installer (Linux/macOS)" \
            "$RELEASE_DIR/install.cmd#HoloGram CLI Installer (Windows)"
        echo ""
        echo "✓ Draft release created. Go to GitHub Releases and click Publish."
    else
        echo "跳过 Release 创建。"
    fi
else
    echo ""
    echo "gh CLI 未安装或未登录。手动操作："
    echo ""
    echo "  1. git add release-bin/"
    echo "  2. git commit -m \"release: update engine binary\""
    echo "  3. git push"
    echo ""
    echo "如果想自动创建 GitHub Release，装 gh CLI:"
    echo "  https://cli.github.com/"
fi

echo ""
echo "=========================================="
echo " Done."
echo "=========================================="
