# check-cache-hitrate.ps1
# Cache hit-rate health check. Reads "llm response" records from .hologram/logs/ui.log
# and reports the LLM cache hit rate per day, flagging abnormally low days.
#
# Two metrics:
#   B pure-cache-rate = cache_hit / (cache_hit + cache_miss)
#       Primary. Measures whether the prompt prefix cache truly matches,
#       unaffected by completion/output tokens.
#   A hit-share      = cache_hit / total_tokens
#       Cost-saving view. Share of all tokens sent to the LLM that came from cache.
# Color coding: <85% bad (red), 85-92% low (yellow), >=92% good (green).
#
# Usage (run from repo root):
#   ./check-cache-hitrate.ps1                # all history, per-day summary
#   ./check-cache-hitrate.ps1 -Days 7        # only the last 7 days
#   ./check-cache-hitrate.ps1 -DetailToday   # also print per-request detail of the latest day
#   ./check-cache-hitrate.ps1 -OnlyA         # only the A metric (no primary B column)
#
# NOTE (strict mode): since 2026-08-14 agent.ts logs cache_miss_tokens and
# completion_tokens in "llm response". Lines WITHOUT cache_miss_tokens are SKIPPED
# and counted, never silently approximated, so the re-count baseline stays clean.
#
# ASCII-only source: no external deps, runs on Windows PowerShell 5.1 and PowerShell 7.
# Kept free of non-ASCII characters so it parses correctly regardless of file
# encoding / BOM (no more UTF-8 BOM dependency).

param(
    [int]$Days = 0,          # 0 = all; >0 = only the last N days
    [switch]$DetailToday,    # also print per-request detail for the latest day
    [switch]$OnlyA,          # only the A metric
    [string]$LogPath = ""    # default resolves to repo .hologram/logs/ui.log
)

$ErrorActionPreference = 'Stop'

# ---------- locate log file ----------
if (-not $LogPath) {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $candidates = @(
        (Join-Path $scriptDir '.hologram\logs\ui.log'),
        (Join-Path (Split-Path -Parent $scriptDir) '.hologram\logs\ui.log')
    )
    $LogPath = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $LogPath -or -not (Test-Path $LogPath)) {
    Write-Host "Could not find ui.log. Put this script in the repo root, or pass -LogPath." -ForegroundColor Red
    exit 1
}

Write-Host "Log file: $LogPath"
$sizeMB = [math]::Round((Get-Item $LogPath).Length / 1MB, 1)
Write-Host ("Size: {0} MB  Last write: {1}" -f $sizeMB, (Get-Item $LogPath).LastWriteTime)
$filter = if ($Days -gt 0) { "last $Days day(s)" } else { "all history" }
Write-Host "Date filter: $filter"
if ($OnlyA) { Write-Host "Metric: A hit-share (cost-saving view only)" }
Write-Host ""

# ---------- read and parse ----------
Write-Host "Parsing log..."
$since = $null
if ($Days -gt 0) { $since = (Get-Date).Date.AddDays(-($Days - 1)) }

$data = @()
$skippedNoMiss = 0  # llm-response lines without cache_miss_tokens, skipped (strict mode)
foreach ($l in ([System.IO.File]::ReadLines($LogPath))) {
    if ($l -notmatch '"message":"llm response"') { continue }
    # strict mode: only count lines that carry cache_miss_tokens (new format since 2026-08-14)
    if ($l -match '"ts":"([^"]+)".*?"total_tokens":(\d+).*?"cache_hit_tokens":(\d+).*?"cache_miss_tokens":(\d+)') {
        $ts = $matches[1]
        if ($since -and $ts -lt $since.ToString('yyyy-MM-dd')) { continue }
        $total = [int64]$matches[2]
        $hit   = [int64]$matches[3]
        $miss  = [int64]$matches[4]
        # optional new fields (2026-08-14+): cache_creation (Anthropic write-cache), reasoning (thinking tokens)
        $creation = 0
        $reason   = 0
        if ($l -match '"cache_creation_tokens":(\d+)') { $creation = [int64]$matches[1] }
        if ($l -match '"reasoning_tokens":(\d+)')        { $reason   = [int64]$matches[1] }
        $data += [pscustomobject]@{
            Day      = $ts.Split('T')[0]
            Hit      = $hit
            Miss     = $miss
            Total    = $total
            Creation = $creation
            Reason   = $reason
        }
    }
    else {
        $skippedNoMiss++
    }
}

if ($data.Count -eq 0) {
    Write-Host "No 'llm response' records in the requested range." -ForegroundColor Yellow
    exit 0
}

Write-Host ("Parsed {0} requests (strict mode, cache_miss truth rows only)." -f $data.Count)
Write-Host ""

# ---------- per-day summary ----------
$rows = foreach ($d in ($data | Group-Object Day | Sort-Object Name)) {
    $sumHit  = ($d.Group | Measure-Object Hit  -Sum).Sum
    $sumMiss = ($d.Group | Measure-Object Miss -Sum).Sum
    $sumTotal = ($d.Group | Measure-Object Total -Sum).Sum
    $sumCreation = ($d.Group | Measure-Object Creation -Sum).Sum
    $sumReason   = ($d.Group | Measure-Object Reason   -Sum).Sum
    $rateB = if (($sumHit + $sumMiss) -gt 0) { [math]::Round(100.0 * $sumHit / ($sumHit + $sumMiss), 2) } else { 0 }
    $rateA = if ($sumTotal -gt 0) { [math]::Round(100.0 * $sumHit / $sumTotal, 2) } else { 0 }
    [pscustomobject]@{
        Date = $d.Name; Responses = $d.Count; HitRateA = $rateA; HitRateB = $rateB
        Creation = $sumCreation; Reason = $sumReason
    }
}

if ($OnlyA) {
    Write-Host "Per-day A hit-share (hit / total tokens, cost-saving view):"
} else {
    Write-Host "Per-day cache hit rate (primary B pure rate; secondary A hit-share):"
}
Write-Host ('{0,-12} {1,8}  {2,9}  {3,9}  {4,10}  {5,12}' -f 'Date', 'Requests', 'B rate %', 'A share %', 'wCache', 'Reasoning')
Write-Host ('-' * 66)
foreach ($r in $rows) {
    $val = if ($OnlyA) { $r.HitRateA } else { $r.HitRateB }
    $color = 'Green'
    if ($val -lt 85) { $color = 'Red' }
    elseif ($val -lt 92) { $color = 'Yellow' }
    # wCache (cache creation) / Reasoning summed in millions of tokens for readability
    Write-Host ('{0,-12} {1,8}  {2,8}%  {3,8}%  {4,10}  {5,12}' -f $r.Date, $r.Responses, $r.HitRateB, $r.HitRateA, $r.Creation, $r.Reason) -ForegroundColor $color
}
if ($skippedNoMiss -gt 0) {
    Write-Host ("(skipped {0} old-format line(s) without cache_miss, not counted in strict mode)" -f $skippedNoMiss) -ForegroundColor DarkYellow
}
Write-Host "wCache = cache_creation_input_tokens (Anthropic write-cache); Reasoning = thinking tokens (DeepSeek/OpenAI)."

# ---------- totals ----------
$sumHit = ($data | Measure-Object Hit -Sum).Sum
$sumMiss = ($data | Measure-Object Miss -Sum).Sum
$sumTotal = ($data | Measure-Object Total -Sum).Sum
$allR = if ($sumHit + $sumMiss -gt 0) { [math]::Round(100.0 * $sumHit / ($sumHit + $sumMiss), 2) } else { 0 }
$allA = if ($sumTotal -gt 0) { [math]::Round(100.0 * $sumHit / $sumTotal, 2) } else { 0 }
$worst = $rows | Sort-Object HitRateB | Select-Object -First 1
Write-Host ""
Write-Host ("Overall B pure rate: {0}%   A hit-share: {1}%  (hit {2:N0} / miss {3:N0})" -f $allR, $allA, $sumHit, $sumMiss)
if ($worst -and $rows.Count -gt 1) {
    Write-Host ("Lowest day: {0}  (B {1}%, {2} request(s))" -f $worst.Date, $worst.HitRateB, $worst.Responses) -ForegroundColor Yellow
}
Write-Host "Reference: B <85% bad, 85-92% low, >=92% good."

# ---------- optional: per-request detail for the latest day ----------
if ($DetailToday) {
    $today = $rows | Select-Object -Last 1
    if ($today) {
        Write-Host ""
        Write-Host "== Per-request detail for $($today.Date) =="
        $todayData = $data | Where-Object { $_.Day -eq $today.Date }
        $i = 0
        foreach ($e in $todayData) {
            $i++
            $rateB = if (($e.Hit + $e.Miss) -gt 0) { [math]::Round(100.0 * $e.Hit / ($e.Hit + $e.Miss), 1) } else { 0 }
            Write-Host ("  #{0,4}  B {1,6}%  (hit {2,8} / miss {3,8})" -f $i, $rateB, $e.Hit, $e.Miss)
        }
    }
}
