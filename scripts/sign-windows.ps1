<#
  sign-windows.ps1 — Windows Authenticode 代码签名唯一入口（本地构建 + CI 共用）
  ============================================================================
  为什么必须有这一步（2026-10-14 定位，用户侧实机复现）：
    Windows 的「打开文件 - 安全警告 / 无法验证发布者」由**两个条件同时成立**触发——
    ① 文件带 Mark-of-the-Web（NTFS 备用数据流 Zone.Identifier，下载/从下载来的压缩包解出/
       从网络位置拷来才会有）；② exe 没有可验证的 Authenticode 签名。
    实机对照（未签名 hello.exe）：无 MOTW ⇒ 静默启动；加 ZoneId=3 ⇒ 弹该框且不启动；
    签名且证书受信任 + MOTW ⇒ 静默启动、无任何弹窗。所以根治 = 给产物签名。

  调用面（两条，都由 src-tauri/tauri.windows.conf.json 接进 tauri build）：
    · build.beforeBundleCommand   —— 不带 -Files：签默认目标集（引擎/lspd/officecli/主程序/
      bundle 里已存在的安装包）。跑在「编译完、打包前」，保证安装包内嵌的是已签名主程序。
    · bundle.windows.signCommand  —— Tauri 以 -Files %1 传单个待签文件（主程序 + NSIS 安装包）。
      ⚠ 安装包必须在 Tauri 生成 updater .sig 之前签完，否则 minisign 签名与文件字节对不上，
      应用内自动更新会校验失败——这就是签名必须在 bundler 内部完成、不能事后补签的原因。

  证书来源（全部经环境变量，未配置 ⇒ 具名跳过，不影响本地构建与发版）：
    LANTAI_SIGN_THUMBPRINT     证书指纹（Cert:\CurrentUser\My 或 LocalMachine\My，可带空格）
    LANTAI_SIGN_SUBJECT        证书主题子串（同库检索，取最新一张带私钥的）
    LANTAI_SIGN_PFX            .pfx 文件路径（CI 里由 secret base64 解码到 RUNNER_TEMP）
    LANTAI_SIGN_PFX_PASSWORD   .pfx 口令
    LANTAI_SIGN_COMMAND        外部签名命令（云 HSM 路线：Azure Artifact Signing / SSL.com eSigner /
                               DigiCert KeyLocker 等）。整条命令行里 %1 = 待签文件路径，由本脚本替换后交给 cmd 执行。
    LANTAI_SIGN_TIMESTAMP      时间戳服务器，默认 http://timestamp.digicert.com
  签名工具：有 signtool.exe 就用它（/fd sha256 /tr /td sha256），否则退回
    Set-AuthenticodeSignature（Windows 自带，无需装 Windows SDK）。

  ⚠ 本脚本自己不需要 signtool，但**Tauri 需要**：bundler 在签 bundle.resources 前先调
    signtool verify 判断「是否已签名」（tauri-bundler 2.10 sign.rs: verify/should_sign）。
    所以「要签名的构建」所在机器必须能拿到 signtool：
      · GitHub windows runner：自带 Windows SDK ⇒ 免配。
      · 本地：装 Windows SDK 的 Signing Tools，或把 TAURI_WINDOWS_SIGNTOOL_PATH 指向任意
        signtool.exe（例如 NuGet 包 Microsoft.Windows.SDK.BuildTools 里那一枚）。
    只跑**未签名**构建（不传本配置）则完全不需要它——tauri.windows.conf.json 里没有签名配置时
    can_sign() 为假，bundler 一个 signtool 都不会找。

  退出码：0 = 签完/按配置跳过；1 = 有文件签名失败（或 -Require 且无证书）。
  本文件由 pwsh 执行（UTF-8 无 BOM）；若改回 powershell.exe（5.1）请给文件加 BOM。
#>
[CmdletBinding()]
param(
  # signCommand 用 -Files %1 传单个路径；也接受多个/逗号分隔
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Files,

  [ValidateSet('auto', 'store', 'pfx', 'command', 'none')]
  [string]$Provider = 'auto',

  [string]$Thumbprint,
  [string]$Subject,
  [string]$PfxPath,
  [string]$PfxPassword,
  [string]$SignCommand,
  [string]$TimestampServer,

  # 缺证书即失败（发版门禁用；本地默认只跳过）
  [switch]$Require,
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

function Say([string]$text) { if (-not $Quiet) { Write-Host $text } }

if (-not $Thumbprint) { $Thumbprint = $env:LANTAI_SIGN_THUMBPRINT }
if (-not $Subject) { $Subject = $env:LANTAI_SIGN_SUBJECT }
if (-not $PfxPath) { $PfxPath = $env:LANTAI_SIGN_PFX }
if (-not $PfxPassword) { $PfxPassword = $env:LANTAI_SIGN_PFX_PASSWORD }
if (-not $SignCommand) { $SignCommand = $env:LANTAI_SIGN_COMMAND }
if (-not $TimestampServer) {
  if ($env:LANTAI_SIGN_TIMESTAMP) { $TimestampServer = $env:LANTAI_SIGN_TIMESTAMP }
  else { $TimestampServer = 'http://timestamp.digicert.com' }
}

# ── 目标文件集 ────────────────────────────────────────────────────────────
function Get-DefaultTargets {
  $list = @()
  foreach ($rel in @(
      'target\release\lantai.exe',
      'target\release\hologram-engine.exe',
      'target\release\hologram-lspd.exe',
      'src-tauri\bin\officecli.exe'
    )) {
    $p = Join-Path $repoRoot $rel
    if (Test-Path -LiteralPath $p) { $list += (Get-Item -LiteralPath $p).FullName }
  }
  $nsisDir = Join-Path $repoRoot 'target\release\bundle\nsis'
  if (Test-Path -LiteralPath $nsisDir) {
    foreach ($f in (Get-ChildItem -LiteralPath $nsisDir -File -Filter '*.exe')) { $list += $f.FullName }
  }
  return $list
}

function Resolve-TargetPath([string]$raw) {
  $candidates = @($raw)
  if (-not [System.IO.Path]::IsPathRooted($raw)) {
    $candidates += (Join-Path $repoRoot $raw)
    $candidates += (Join-Path (Join-Path $repoRoot 'src-tauri') $raw)
  }
  foreach ($c in $candidates) {
    if (Test-Path -LiteralPath $c) { return (Get-Item -LiteralPath $c).FullName }
  }
  return $null
}

# 空串/空数组都算「没传文件」——转发器在本该传默认集时也会带上 -Files ""
$fileArgs = @($Files | Where-Object { $_ -and $_.Trim() })
$targets = @()
foreach ($f in $fileArgs) {
  foreach ($piece in ($f -split ',')) {
    $trimmed = $piece.Trim()
    if (-not $trimmed) { continue }
    $resolved = Resolve-TargetPath $trimmed
    if ($resolved) {
      if ($targets -notcontains $resolved) { $targets += $resolved }
    }
    else {
      Write-Host "[sign] 待签文件不存在：$trimmed" -ForegroundColor Yellow
      $missing = $true
    }
  }
}
if ($targets.Count -eq 0) {
  if ($fileArgs.Count -gt 0) {
    Write-Host '[sign] 传入的路径一个都没找到，终止（不静默放过）。'
    exit 1
  }
  $targets = Get-DefaultTargets
}
if ($targets.Count -eq 0) {
  Say '[sign] 没有可签的产物（构建还没产出 exe？），跳过。'
  exit 0
}

# ── 证书解析 ─────────────────────────────────────────────────────────────
$cert = $null
$certHow = ''
$usingPfx = $false

if ($Provider -eq 'auto') {
  if ($SignCommand) { $Provider = 'command' }
  elseif ($PfxPath) { $Provider = 'pfx' }
  elseif ($Thumbprint -or $Subject) { $Provider = 'store' }
  else { $Provider = 'none' }
}

if ($Provider -eq 'pfx') {
  if (-not $PfxPath -or -not (Test-Path -LiteralPath $PfxPath)) {
    Say "[sign] 配了 pfx 方式但找不到证书文件：$PfxPath"
    exit 1
  }
  $flags = [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
  $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($PfxPath, $PfxPassword, $flags)
  $usingPfx = $true
  $certHow = 'pfx ' + $PfxPath + ' -> ' + $cert.Subject
}
elseif ($Provider -eq 'store') {
  $want = ''
  if ($Thumbprint) { $want = ($Thumbprint -replace '\s', '').ToUpperInvariant() }
  $found = @()
  foreach ($loc in @('CurrentUser', 'LocalMachine')) {
    $store = New-Object System.Security.Cryptography.X509Certificates.X509Store('My', $loc)
    $store.Open('ReadOnly')
    foreach ($c in $store.Certificates) {
      if (-not $c.HasPrivateKey) { continue }
      if ($want) {
        if ($c.Thumbprint -eq $want) { $found += $c }
      }
      elseif ($Subject) {
        if ($c.Subject -like ('*' + $Subject + '*')) { $found += $c }
      }
    }
    $store.Close()
  }
  if ($found.Count -gt 0) {
    $cert = $found | Sort-Object NotAfter -Descending | Select-Object -First 1
    $certHow = 'store ' + $cert.Subject + ' [' + $cert.Thumbprint + ']'
  }
}

elseif ($Provider -eq 'command') {
  if (-not $SignCommand) {
    Say '[sign] 配了 command 方式但没有 LANTAI_SIGN_COMMAND。'
    exit 1
  }
  $certHow = '外部命令 ' + $SignCommand
}

if (-not $cert -and $Provider -ne 'command') {
  $reason = '未配置代码签名证书（LANTAI_SIGN_THUMBPRINT / LANTAI_SIGN_SUBJECT / LANTAI_SIGN_PFX / LANTAI_SIGN_COMMAND 都没命中）'
  Say ('[sign] 跳过签名：' + $reason)
  Say ('[sign] 待签 ' + $targets.Count + ' 个文件；后果：产物未签名，用户下载后双击会看到「打开文件 - 安全警告 / 未知发布者」。')
  if ($Require) {
    Say '[sign] -Require 已指定：无证书即失败。'
    exit 1
  }
  exit 0
}

# ── 签名工具 ─────────────────────────────────────────────────────────────
$signtool = $null
$cmd = Get-Command 'signtool.exe' -ErrorAction SilentlyContinue
if ($cmd) { $signtool = $cmd.Source }
if (-not $signtool) {
  foreach ($root in @('C:\Program Files (x86)\Windows Kits\10\bin', 'C:\Program Files\Windows Kits\10\bin')) {
    if (Test-Path -LiteralPath $root) {
      $hit = Get-ChildItem -LiteralPath $root -Recurse -Filter 'signtool.exe' -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending | Select-Object -First 1
      if ($hit) { $signtool = $hit.FullName; break }
    }
  }
}

Say ('[sign] 证书：' + $certHow)
if ($Provider -eq 'command') {
  Say '[sign] 工具：外部命令（LANTAI_SIGN_COMMAND）'
}
else {
  Say ('[sign] 工具：' + $(if ($signtool) { $signtool } else { 'Set-AuthenticodeSignature（未装 Windows SDK）' }))
}
Say ('[sign] 时间戳：' + $TimestampServer)

# ── 逐个签名 ─────────────────────────────────────────────────────────────
$ok = @()
$failed = @()
foreach ($path in $targets) {
  try {
    if ($Provider -eq 'command') {
      $line = $SignCommand.Replace('%1', $path)
      & cmd.exe /c $line | Out-Null
      if ($LASTEXITCODE -ne 0) { throw ('外部签名命令退出码 ' + $LASTEXITCODE + ' :: ' + $line) }
    }
    elseif ($signtool) {
      if ($usingPfx) {
        $toolArgs = @('sign', '/fd', 'sha256', '/td', 'sha256', '/tr', $TimestampServer, '/f', $PfxPath, '/p', $PfxPassword, $path)
      }
      else {
        $toolArgs = @('sign', '/fd', 'sha256', '/td', 'sha256', '/tr', $TimestampServer, '/sha1', $cert.Thumbprint, $path)
      }
      & $signtool @toolArgs | Out-Null
      if ($LASTEXITCODE -ne 0) { throw ('signtool 退出码 ' + $LASTEXITCODE) }
    }
    else {
      Set-AuthenticodeSignature -LiteralPath $path -Certificate $cert -HashAlgorithm SHA256 -TimestampServer $TimestampServer | Out-Null
    }
  }
  catch {
    $failed += ($path + ' :: 签名命令失败 :: ' + $_.Exception.Message)
    continue
  }

  $sig = Get-AuthenticodeSignature -LiteralPath $path
  if (-not $sig.SignerCertificate) {
    $failed += ($path + ' :: 签完仍无签名（' + $sig.Status + '）')
  }
  elseif ($sig.Status -ne 'Valid') {
    # 证书链未受信任（新证书/中间证书未装）不算签名失败，但必须喊出来
    Say ('[sign] 已签但链状态非 Valid：' + $sig.Status + ' :: ' + $path + ' :: ' + $sig.SignerCertificate.Subject)
    $ok += ($path + ' :: ' + $sig.Status)
  }
  else {
    Say ('[sign] ok  ' + [System.IO.Path]::GetFileName($path) + '  (' + $sig.SignerCertificate.Subject + ')')
    $ok += ($path + ' :: Valid')
  }
}

Say ('[sign] 完成：签名 ' + $ok.Count + ' 个，失败 ' + $failed.Count + ' 个')
foreach ($f in $failed) { Write-Host ('[sign] 失败 ' + $f) -ForegroundColor Red }
if ($failed.Count -gt 0) { exit 1 }
exit 0
