#!/usr/bin/env bash
# Build tree-sitter grammar shared libs for HoloGram dynamic loading.
# Usage: ./build.sh <language>
#        ./build.sh --all        # batch build from grammars.txt list
#
# Requires: git, gcc/g++
# Output:  grammars/tree-sitter-<lang>.so    (Linux)
#          grammars/tree-sitter-<lang>.dylib  (macOS)

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/build"
OUT_DIR="$SCRIPT_DIR"

# Detect platform: .so on Linux, .dylib on macOS
case "$(uname -s)" in
    Darwin) EXT="dylib" ;;
    *)      EXT="so" ;;
esac

build_grammar() {
    local lang="$1"
    local repo_url="https://github.com/tree-sitter-grammars/tree-sitter-$lang.git"
    local repo_dir="$BUILD_DIR/tree-sitter-$lang"
    local out_name="tree-sitter-$lang.$EXT"
    local out_path="$OUT_DIR/$out_name"

    echo -e "\033[36m=== Building $lang ===\033[0m"

    if [ ! -d "$repo_dir" ]; then
        echo "  cloning $repo_url ..."
        git clone --depth 1 "$repo_url" "$repo_dir" 2>&1 | tail -1
    fi

    local parser_c
    parser_c=$(find "$repo_dir" -name "parser.c" -type f | head -1)
    if [ -z "$parser_c" ]; then
        echo -e "\033[31m  ERROR: no parser.c found in $repo_dir\033[0m"
        return 1
    fi

    local src_dir
    src_dir="$(dirname "$parser_c")"
    local src_files=("$parser_c")
    [ -f "$src_dir/scanner.c" ]  && src_files+=("$src_dir/scanner.c")
    [ -f "$src_dir/scanner.cc" ] && src_files+=("$src_dir/scanner.cc")

    local gcc_args=(
        -shared -o "$out_path"
        -I "$src_dir"
        -fPIC -O2
        "${src_files[@]}"
    )

    echo "  gcc ${gcc_args[*]}"
    gcc "${gcc_args[@]}"

    local size_kb
    size_kb=$(du -k "$out_path" | cut -f1)
    echo -e "\033[32m  OK -> $out_name (${size_kb} KB)\033[0m"
}

if [ "${1:-}" = "--all" ]; then
    list_file="$SCRIPT_DIR/grammars.txt"
    if [ ! -f "$list_file" ]; then
        echo "No grammars.txt found." >&2
        exit 1
    fi
    while IFS= read -r line; do
        line="$(echo "$line" | sed 's/#.*//' | xargs)"
        [ -n "$line" ] && build_grammar "$line"
    done < "$list_file"
elif [ -n "${1:-}" ]; then
    build_grammar "$1"
else
    echo "Usage:"
    echo "  ./build.sh kotlin       # build one grammar"
    echo "  ./build.sh --all         # batch build from grammars.txt"
    echo ""
    echo "Requires: git, gcc"
    echo "Output:   grammars/tree-sitter-<lang>.$EXT"
fi
