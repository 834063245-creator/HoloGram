# Copyright (c) 2026 Wenbing Jing. MIT License.
# SPDX-License-Identifier: MIT

"""Generate base64-encoded PowerShell command for uninstall cleanup WiX fragment."""
import base64

# PowerShell script — use explicit newlines, be careful with quotes
lines = [
    '$w = New-Object -ComObject WScript.Shell',
    "$r = $w.Popup('卸载后是否同时删除用户数据？",
    "",
    "包括 API Key、设置等。",
    '点击"是"删除，点击"否"保留。',
    "",
    "（不影响项目文件）', 0, '全息观测站 卸载', 4+32)",
    "if ($r -eq 6) {",
    '    $path = $env:LOCALAPPDATA + "\\com.hologram.app"',
    "    Remove-Item -Path $path -Recurse -Force -ErrorAction SilentlyContinue",
    "}",
]

script = "\n".join(lines)
encoded = base64.b64encode(script.encode("utf-16-le")).decode()
print(encoded)
