# Build tree-sitter grammar DLLs for HoloGram dynamic loading.
# Usage: .\build.ps1 <language>
#        .\build.ps1 -All        # batch build from grammars.txt list
#
# Requires: git, gcc/g++ (mingw64)
# Note:    markdown requires -DTREE_SITTER_MARKDOWN_AVOID_CRASH for C++ scanner
# Output:  grammars/tree-sitter-<lang>.dll

param(
    [string]$Language,
    [switch]$All
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BuildDir  = Join-Path $ScriptDir "build"
$OutDir    = $ScriptDir  # grammars/ directory

function Build-Grammar($lang) {
    $repoUrl = "https://github.com/tree-sitter/tree-sitter-$lang.git"
    $repoDir = Join-Path $BuildDir "tree-sitter-$lang"
    $dllName = "tree-sitter-$lang.dll"
    $dllPath = Join-Path $OutDir $dllName

    Write-Host "=== Building $lang ===" -ForegroundColor Cyan

    # Clone if not already present
    if (-not (Test-Path $repoDir)) {
        Write-Host "  cloning $repoUrl ..."
        git clone --depth 1 $repoUrl $repoDir 2>&1 | Out-Null
    }

    $srcDir = Join-Path $repoDir "src"
    if (-not (Test-Path $srcDir)) {
        Write-Host "  ERROR: no src/ in $repoDir" -ForegroundColor Red
        return
    }

    $parserC = Join-Path $srcDir "parser.c"
    $scannerC = Join-Path $srcDir "scanner.c"
    $scannerCC = Join-Path $srcDir "scanner.cc"

    if (-not (Test-Path $parserC)) {
        Write-Host "  ERROR: no parser.c in $srcDir" -ForegroundColor Red
        return
    }

    $srcFiles = @($parserC)
    if (Test-Path $scannerC)  { $srcFiles += $scannerC }
    if (Test-Path $scannerCC) { $srcFiles += $scannerCC }

    $gccArgs = @(
        "-shared", "-o", $dllPath,
        "-I", $srcDir,
        "-fPIC", "-O2"
    ) + $srcFiles

    Write-Host "  gcc $($gccArgs -join ' ')"
    & gcc @gccArgs

    if ($LASTEXITCODE -ne 0) {
        Write-Host "  FAILED" -ForegroundColor Red
    } else {
        $size = [math]::Round((Get-Item $dllPath).Length / 1KB, 0)
        Write-Host "  OK -> $dllName ($size KB)" -ForegroundColor Green
    }
}

if ($All) {
    $listFile = Join-Path $ScriptDir "grammars.txt"
    if (-not (Test-Path $listFile)) {
        Write-Host "No grammars.txt found. Create one with one language per line." -ForegroundColor Yellow
        exit 1
    }
    Get-Content $listFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#")) {
            Build-Grammar $line
        }
    }
} elseif ($Language) {
    Build-Grammar $Language
} else {
    Write-Host @"
Usage:
  .\build.ps1 kotlin        # build one grammar
  .\build.ps1 -All          # batch build from grammars.txt

Requires: git, gcc (mingw64)
Output:   grammars/tree-sitter-<lang>.dll
"@
}
