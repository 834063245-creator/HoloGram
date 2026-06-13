#!/bin/bash
# setup-embedded-python.sh — 首次运行：下载 Python embeddable + 安装依赖
# 只需运行一次。之后每次 cargo tauri build 会自动同步 src_python。

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT="$(cd "$SCRIPT_DIR/.." && pwd)"
PYTHON_DIR="$PROJECT/src-tauri/python"
PYTHON_VER="3.14.4"
PYTHON_ZIP="python-${PYTHON_VER}-embed-amd64.zip"
PYTHON_URL="https://www.python.org/ftp/python/${PYTHON_VER}/${PYTHON_ZIP}"

echo "=== 全息观测站 · 嵌入式 Python 准备 ==="

# 1) download embeddable Python
if [ -f "$SCRIPT_DIR/$PYTHON_ZIP" ]; then
    echo "[1/5] 使用已下载的 $PYTHON_ZIP"
else
    echo "[1/5] 下载 Python $PYTHON_VER embeddable..."
    curl -L -o "$SCRIPT_DIR/$PYTHON_ZIP" "$PYTHON_URL"
fi

# 2) extract
echo "[2/5] 解压到 $PYTHON_DIR..."
rm -rf "$PYTHON_DIR"
mkdir -p "$PYTHON_DIR"
unzip -q "$SCRIPT_DIR/$PYTHON_ZIP" -d "$PYTHON_DIR"

# 3) configure ._pth for pip + site-packages
echo "[3/5] 配置 ._pth..."
cat > "$PYTHON_DIR/python314._pth" << 'EOF'
python314.zip
.
Lib\site-packages

# Uncomment to run site.main() automatically
import site
EOF

# 4) install pip
echo "[4/5] 安装 pip..."
curl -sSL "https://bootstrap.pypa.io/get-pip.py" -o "$SCRIPT_DIR/get-pip.py"
"$PYTHON_DIR/python.exe" "$SCRIPT_DIR/get-pip.py" --no-warn-script-location

# 5) install deps
echo "[5/5] 安装依赖..."
"$PYTHON_DIR/python.exe" -m pip install --no-warn-script-location \
    networkx \
    "igraph>=0.11" \
    "leidenalg>=0.10" \
    "msgpack>=1.0" \
    "PyYAML>=6.0" \
    "tree-sitter>=0.22"

# verify
echo ""
echo "=== 验证 ==="
"$PYTHON_DIR/python.exe" -c "import networkx; import igraph; import leidenalg; import msgpack; import yaml; import tree_sitter; print('所有依赖 OK')"

# initial sync of src_python
echo ""
echo "=== 初始同步 src_python ==="
rm -rf "$PYTHON_DIR/Lib/site-packages/src_python"
cp -r "$PROJECT/src_python" "$PYTHON_DIR/Lib/site-packages/src_python"
find "$PYTHON_DIR/Lib/site-packages/src_python" -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
"$PYTHON_DIR/python.exe" -c "import src_python; print('src_python OK')"

echo ""
echo "=== 完成 ==="
echo "嵌入式 Python 大小: $(du -sh "$PYTHON_DIR" | cut -f1)"
echo "现在可以运行: cargo tauri build"
