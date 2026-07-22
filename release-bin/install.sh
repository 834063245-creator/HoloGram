#!/usr/bin/env bash
# HoloGram CLI installer — copies wrapper + engine to a PATH directory.
#
# Usage:
#   ./install.sh           install to /usr/local/bin (may need sudo)
#   ./install.sh --user    install to ~/.local/bin (no sudo needed)
#
# After install, `hologram` is available everywhere.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USER_MODE=false

if [ "$1" = "--user" ]; then
    USER_MODE=true
fi

if $USER_MODE; then
    DEST="$HOME/.local/bin"
else
    DEST="/usr/local/bin"
fi

mkdir -p "$DEST"

# Copy engine binary
for ext in "" ".exe"; do
    SRC="$SCRIPT_DIR/hologram-engine${ext}"
    if [ -f "$SRC" ]; then
        cp -f "$SRC" "$DEST/hologram-engine${ext}"
        chmod +x "$DEST/hologram-engine${ext}"
        echo "  ✓ $DEST/hologram-engine${ext}"
    fi
done

# Copy CLI wrapper
cp -f "$SCRIPT_DIR/hologram" "$DEST/hologram"
chmod +x "$DEST/hologram"
echo "  ✓ $DEST/hologram"

# For --user mode, ensure ~/.local/bin is on PATH
if $USER_MODE; then
    case ":$PATH:" in
        *":$DEST:"*) ;;
        *)
            echo ""
            echo "⚠ $DEST is not on your PATH."
            echo "  Add this line to your ~/.bashrc or ~/.zshrc:"
            echo ""
            echo "    export PATH=\"$DEST:\$PATH\""
            ;;
    esac
fi

echo ""
echo "Done. Run: hologram --version"
