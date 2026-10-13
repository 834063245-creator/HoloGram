<#
.SYNOPSIS
  OfficeCLI × 兰台 集成预检（只读诊断，不改任何东西）。

.DESCRIPTION
  把「真机验收清单」变成一条命令：逐项检查二进制/（可选的）活预览窗/退役面 + 旧技能副本残留，
  每项给 ✓/✗ + 一句怎么修。**不写任何文件、不起任何进程**——纯诊断。
  验收时把整段输出贴回来即可定位问题。

  形态说明（2026-09-13 C 路改判后；2026-09-15 R3 重构）：OfficeCLI 的读写能力由兰台**内置
  office 域工具**（office(action,…)）承担——二进制放标准安装位即被**强制层**定位
  （`process_cap::office_exec`：命令由 Rust 拼装，权限只审声明的目标文件）；**不再需要**
  `~/.lantai/mcp.json` 挂接，也不需要插件自带二进制。本脚本因此把「MCP 条目残留」
  当成需要清理的项来检查。

.EXAMPLE
  .\preflight.ps1
#>
[CmdletBinding()]
param(
  [string]$Version = '1.0.149',
  [int]$WatchPort = 26315,
  [string]$ToolsDir = (Join-Path $env:USERPROFILE '.lantai\tools\officecli'),
  [string]$UserLantaiDir = (Join-Path $env:USERPROFILE '.lantai'),
  [string]$PluginDir = (Join-Path $PSScriptRoot '..\plugins\office')
)

$ErrorActionPreference = 'Continue'

# 与 install-officecli.ps1 同一张固定版本表（升级 = 两处同改）
$PINNED = @{
  '1.0.149' = 'abd82dae417b66aae62d1ec8edbf88ba9d5be7442b55be470b34b764f10731e2'
}
$BIN = Join-Path $ToolsDir 'officecli.exe'
$MCP_JSON = Join-Path $UserLantaiDir 'mcp.json'
$SKILL = Join-Path $UserLantaiDir 'skills\officecli\SKILL.md'
$PLUGIN_INSTALLED = Join-Path $UserLantaiDir 'plugins\office\manifest.json'

$results = @()
function Check([string]$name, [bool]$ok, [string]$detail, [string]$fix) {
  $script:results += [pscustomobject]@{ name = $name; ok = $ok; detail = $detail; fix = $fix }
}

Write-Host ''
Write-Host '══ OfficeCLI × 兰台 集成预检 ══' -ForegroundColor Cyan

# ── 1. 二进制（必需：强制层按 $OFFICECLI_PATH → 标准安装位 → PATH 定位它）──
if (Test-Path -LiteralPath $BIN -PathType Leaf) {
  $hash = (Get-FileHash -LiteralPath $BIN -Algorithm SHA256).Hash.ToLower()
  $want = $PINNED[$Version]
  $hashOk = ($null -eq $want) -or ($hash -eq $want)
  $ver = (& $BIN --version 2>$null | Select-Object -First 1)
  Check '二进制在位' $true "$BIN（$([math]::Round((Get-Item -LiteralPath $BIN).Length/1MB,2)) MB，--version=$ver）" ''
  Check '哈希与 pin 一致' $hashOk "期望 $want / 实得 $hash" '重跑 install-officecli.ps1（会拒绝坏件并重装）'
  Check '版本与 pin 一致' ($ver -eq $Version) "期望 $Version / 实得 $ver" "换装 pin 版本：install-officecli.ps1 -FromRelease -Version $Version"
}
else {
  Check '二进制在位' $false "缺：$BIN" '跑 examples/office-cli/install-officecli.ps1 -FromRelease（或 -FromLocal <已下载件>）——office 域工具靠它工作'
}

# ── 2. 技能（2026-10-13 起随兰台出厂，name: officecli——盘上不再需要文件）──
# 旧文档曾要求手动拷 SKILL.md 到用户技能根；该副本会覆盖出厂版（用户 > 出厂），
# 检出即提示删除。不入关键项（出厂技能在应用 bundle 里，本脚本够不着）。
if (Test-Path -LiteralPath $SKILL -PathType Leaf) {
  Check '旧手动技能副本' $false "发现 $SKILL——会覆盖随兰台出厂的技能（name: officecli）" '删除该技能目录：出厂技能已随应用分发，无需盘上副本'
}
else {
  Check '旧手动技能副本' $true '无（技能随兰台出厂分发，无需安装）' ''
}

# ── 3. 退役面：MCP 条目应当已被清理（C 路改判）──
if (Test-Path -LiteralPath $MCP_JSON -PathType Leaf) {
  try {
    $raw = Get-Content -LiteralPath $MCP_JSON -Raw | ConvertFrom-Json
    $servers = @($raw.mcpServers)
    $legacyOffice = @($servers | Where-Object { $_.name -eq 'office' })
    if ($legacyOffice.Count -gt 0) {
      Check 'MCP 挂接已退役' $false "mcp.json 里仍有 name=office 条目（共 $($servers.Count) 条 server）" '删掉该条目——读写能力已归内置 office 域工具；留着会同时暴露 mcp__office__officecli 与 office 两个面'
    }
    else {
      Check 'MCP 挂接已退役' $true "mcp.json 无 office 条目（现有 server：$((@($servers | ForEach-Object { $_.name }) -join ', '))）" ''
    }
  }
  catch {
    Check 'mcp.json 可解析' $false "解析失败：$($_.Exception.Message)" '检查 JSON 语法或删除该文件（C 路形态不需要它）'
  }
}
else {
  Check 'MCP 挂接已退役' $true '无 mcp.json（C 路形态不需要）' ''
}

# ── 4. 活预览窗插件（可选件）──
if (Test-Path -LiteralPath $PLUGIN_INSTALLED -PathType Leaf) {
  Check '活预览窗插件已安装（可选）' $true "$PLUGIN_INSTALLED" ''
}
else {
  $srcManifest = Join-Path $PluginDir 'manifest.json'
  $srcState = if (Test-Path -LiteralPath $srcManifest -PathType Leaf) { '源码在' } else { '源码缺' }
  Check '活预览窗插件（可选）' $false "未安装（$PluginDir，$srcState）" '要用活预览：设置 → 插件 → 安装框填该目录绝对路径'
}

# ── 5. 活预览服务（watch）──
$listening = $false
try {
  $listening = (Test-NetConnection -ComputerName 127.0.0.1 -Port $WatchPort -InformationLevel Quiet -WarningAction SilentlyContinue)
}
catch { $listening = $false }
if ($listening) {
  $status = ''
  try {
    $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$WatchPort/" -TimeoutSec 5 -UseBasicParsing
    $status = "HTTP $($resp.StatusCode) / $([math]::Round($resp.RawContentLength/1KB)) KB"
  }
  catch { $status = "端口在听但 HTTP 取不到：$($_.Exception.Message)" }
  Check "活预览服务（127.0.0.1:$WatchPort）" $true "在听；$status" ''
}
else {
  Check "活预览服务（127.0.0.1:$WatchPort）" $false '未在听（= 没起 watch；截图路不需要它）' 'officecli watch <文件>（或让 Agent 走 shell 后台起）；之后 office_preview_open 才有东西可显示'
}

# ── 6. 进程卫生（信息项）──
$procs = @(Get-Process officecli -ErrorAction SilentlyContinue)
Check '常驻进程' $true "officecli 进程数：$($procs.Count)（resident 缓存，60s 空闲自退；office 域工具已钉立即落盘，无需手动 save）" ''

# ── 汇总 ──
Write-Host ''
foreach ($r in $results) {
  $mark = if ($r.ok) { '✓' } else { '✗' }
  $color = if ($r.ok) { 'Green' } else { 'Yellow' }
  Write-Host ("  {0} {1}：{2}" -f $mark, $r.name, $r.detail) -ForegroundColor $color
  if (-not $r.ok -and $r.fix) { Write-Host ("      → {0}" -f $r.fix) -ForegroundColor DarkGray }
}

# 关键项（二进制 + pin 一致）决定退出码；可选/信息项不计
$critical = @('二进制在位', '哈希与 pin 一致', '版本与 pin 一致')
$failed = @($results | Where-Object { -not $_.ok -and $_.name -in $critical })
Write-Host ''
if ($failed.Count -eq 0) {
  Write-Host '预检结论：关键项全过（二进制 + pin 一致）——重启兰台后开新会话，office 域工具即可用。' -ForegroundColor Green
  Write-Host '  真机验收见 docs/archive/kernel-tooling-line/office-cli-integration-plan.md §8。' -ForegroundColor DarkGray
  exit 0
}
Write-Host '预检结论：有未过项（见上方 → 提示）。' -ForegroundColor Yellow
exit 1
