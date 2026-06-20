#!/bin/bash
# ============================================================
# HoloGram Release Builder
# 本地构建 → 拷贝 .exe 到 release-bin/ → 上传 GitHub Release
#
# 没有 gh CLI 也能用，会自动把 .exe 拷到 release-bin/ 目录
# 你 git add release-bin/ && git commit && git push 就行
# ============================================================

set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RELEASE_DIR="$ROOT/release-bin"

echo "=========================================="
echo " HoloGram Release Builder"
echo "=========================================="

# ── Step 1: Build Engine ──
echo ""
echo "[1/3] Building hologram-engine.exe..."
cd engine
cargo build --release
echo "  ✓ engine/target/release/hologram-engine.exe"
cd "$ROOT"

# ── Step 2: Copy .exe to release-bin/ ──
echo ""
echo "[2/3] Copying .exe to release-bin/..."
mkdir -p "$RELEASE_DIR"
cp -f engine/target/release/hologram-engine.exe "$RELEASE_DIR/"
echo "  ✓ release-bin/hologram-engine.exe"
ls -lh "$RELEASE_DIR/hologram-engine.exe"

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
            "$RELEASE_DIR/hologram-engine.exe#HoloGram Engine (MCP Server)"
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
    echo "  2. git commit -m \"release: update engine.exe\""
    echo "  3. git push"
    echo ""
    echo "如果想自动创建 GitHub Release，装 gh CLI:"
    echo "  https://cli.github.com/"
fi

echo ""
echo "=========================================="
echo " Done."
echo "=========================================="
