#!/usr/bin/env bash
# MSYS2 捆绑工具集依赖闭包自检（shell-stability P0）。
# 用法：bash scripts/check-msys2-deps.sh [vendor/bin 路径]
# 需要 objdump（Linux binutils）。任何非系统 DLL 缺口 → 退出码 1。
set -euo pipefail

BIN="${1:-$(dirname "$0")/../src-tauri/vendor/msys2/bin}"

if ! command -v objdump >/dev/null 2>&1; then
  echo "[check-msys2-deps] 需要 objdump（binutils）" >&2
  exit 2
fi
[ -d "$BIN" ] || { echo "[check-msys2-deps] 目录不存在: $BIN" >&2; exit 2; }

# Windows 系统 DLL 白名单（由 OS 提供，不随包分发）
SYS="kernel32 advapi32 user32 gdi32 shell32 ws2_32 dbghelp ole32 oleaut32 rpcrt4 \
msvcrt msvcp140 vcruntime140 vcruntime140_1 version imm32 winmm netapi32 secur32 \
crypt32 bcrypt iphlpapi wsock32 psapi shlwapi comdlg32 comctl32 dbgeng dbgmodel \
oleacc uxtheme dxgi d3d11 setupapi cfgmgr32 ntdll mpr winspool userenv wininet \
normaliz powrprof profapi wer"

have=$(ls "$BIN" | tr '[:upper:]' '[:lower:]')
missing=0

for f in "$BIN"/*.exe "$BIN"/*.dll; do
  [ -f "$f" ] || continue
  while read -r dll; do
    [ -n "$dll" ] || continue
    l=$(echo "$dll" | tr '[:upper:]' '[:lower:]')
    base="${l%.dll}"
    case " $SYS " in
      *" $base "*) continue ;;
      *"api-ms-win-"*) continue ;;
    esac
    if ! echo "$have" | grep -qx "$l"; then
      echo "[check-msys2-deps] 缺口: $l (需要者: $(basename "$f"))" >&2
      missing=1
    fi
  done < <(objdump -p "$f" 2>/dev/null | grep "DLL Name" | awk '{print $3}')
done

if [ "$missing" -eq 0 ]; then
  echo "[check-msys2-deps] 依赖闭包完整 ($BIN)"
else
  echo "[check-msys2-deps] 存在缺口，补齐对应 MSYS2 包后重跑" >&2
fi
exit "$missing"
