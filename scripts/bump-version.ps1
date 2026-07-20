# Auto-bump patch version in tauri.conf.json and Cargo.toml
# Usage: .\scripts\bump-version.ps1   (bumps patch)
#        .\scripts\bump-version.ps1 minor  (bumps minor, resets patch to 0)
#        .\scripts\bump-version.ps1 1.5.0  (sets exact version)

param([string]$bump = "patch")

$root = Split-Path -Parent $PSScriptRoot
$tauriConf = Join-Path $root "src-tauri\tauri.conf.json"
$cargoToml = Join-Path $root "src-tauri\Cargo.toml"

# ── Read current version from tauri.conf.json ──
$conf = Get-Content $tauriConf -Raw | ConvertFrom-Json
$ver = $conf.version
if (-not $ver) { Write-Error "未找到 version 字段"; exit 1 }

$parts = $ver -split '\.'
$major = [int]$parts[0]
$minor = [int]$parts[1]
$patch = [int]$parts[2]

# ── Compute new version ──
if ($bump -match '^\d+\.\d+\.\d+$') {
    $newVer = $bump
} elseif ($bump -eq 'minor') {
    $newVer = "$major.$($minor + 1).0"
} elseif ($bump -eq 'major') {
    $newVer = "$($major + 1).0.0"
} else {
    $newVer = "$major.$minor.$($patch + 1)"
}

Write-Host "$ver → $newVer" -ForegroundColor Cyan

# ── Update tauri.conf.json ──
$conf.version = $newVer
$conf | ConvertTo-Json -Depth 10 | Set-Content $tauriConf -Encoding utf8

# ── Update Cargo.toml ──
$toml = Get-Content $cargoToml -Raw
$toml = $toml -replace '^version\s*=\s*"[^"]*"', "version = `"$newVer`""
Set-Content $cargoToml $toml -Encoding utf8 -NoNewline

# ── Auto-commit (optional) ──
# git -C $root add $tauriConf $cargoToml
# git -C $root commit -m "chore: bump version to $newVer"

Write-Host "✔ tauri.conf.json + Cargo.toml → $newVer" -ForegroundColor Green
