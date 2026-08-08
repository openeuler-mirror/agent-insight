# ============================================================================
# Agent Insight TRAE Collector — Debug Viewer (PowerShell)
# Reads spool files from ~\.agent-insight\otel_data\trae\ and displays summary.
#
# Usage:
#   pwsh -File debug-view.ps1
#   pwsh -File debug-view.ps1 -Date 2026-07-27
#   pwsh -File debug-view.ps1 -SessionId "ses_abc"
# ============================================================================

param(
    [string]$Date,
    [string]$SessionId
)

$ErrorActionPreference = 'Stop'

$insightDir = if ($env:AGENT_INSIGHT_DIR) { $env:AGENT_INSIGHT_DIR } else { "$env:USERPROFILE\.agent-insight" }
$spoolBase = "$insightDir\otel_data\trae"

if (-not (Test-Path $spoolBase -PathType Container)) {
    Write-Host "Spool directory not found: $spoolBase"
    Write-Host ""
    Write-Host "No data collected yet. Run an agent with TRAE collector enabled to generate data."
    exit 0
}

$jsonlFiles = @(Get-ChildItem -Path $spoolBase -Recurse -Filter '*.jsonl' -File -ErrorAction SilentlyContinue)

if ($jsonlFiles.Count -eq 0) {
    Write-Host "No spool files found in: $spoolBase"
    exit 0
}

$allEvents = @()
$totalLines = 0
$parseErrors = 0

foreach ($file in $jsonlFiles) {
    $fileDate = $file.Directory.Name
    if ($Date -and ($fileDate -ne $Date)) { continue }
    try {
        $lines = Get-Content $file.FullName -Encoding UTF8 -ErrorAction SilentlyContinue
    } catch {
        continue
    }
    foreach ($line in $lines) {
        $trimmed = $line.Trim()
        if (-not $trimmed) { continue }
        $totalLines++
        try {
            $ev = $trimmed | ConvertFrom-Json
            $evObject = @{
                t = if ($ev.t) { $ev.t.ToString() } else { '' }
                kind = if ($ev.kind) { $ev.kind.ToString() } else { '' }
                sessionID = if ($ev.sessionID) { $ev.sessionID.ToString() } else { '' }
                agent_id = if ($ev.agent_id) { $ev.agent_id.ToString() } else { '' }
                agent_type = if ($ev.agent_type) { $ev.agent_type.ToString() } else { '' }
                file = $file.FullName
            }
            if ($SessionId -and ($evObject.sessionID -ne $SessionId)) { continue }
            $allEvents += $evObject
        } catch {
            $parseErrors++
        }
    }
}

if ($allEvents.Count -eq 0) {
    Write-Host "No matching events found."
    exit 0
}

$sessions = $allEvents | Group-Object { $_.sessionID }

$eventKinds = $allEvents | Group-Object { $_.kind }
$toolCount = ($allEvents | Where-Object { $_.kind -like 'tool.*' }).Count
$llmCount = ($allEvents | Where-Object { $_.kind -like 'llm.*' }).Count
$skillCount = ($allEvents | Where-Object { $_.kind -like 'skill.*' }).Count
$mcpCount = ($allEvents | Where-Object { $_.kind -like 'mcp.*' }).Count

$latestTs = ''
foreach ($ev in $allEvents) {
    if ($ev.t -and ($ev.t -gt $latestTs)) { $latestTs = $ev.t }
}

Write-Host "=============================================="
Write-Host " TRAE Spool Summary"
Write-Host "=============================================="
Write-Host "  Files scanned  : $($jsonlFiles.Count)"
Write-Host "  Total lines    : $totalLines"
if ($parseErrors -gt 0) {
    Write-Host "  Parse errors   : $parseErrors"
}
Write-Host "  Events parsed  : $($allEvents.Count)"
Write-Host "  Session count  : $($sessions.Count)"
Write-Host "  Tool events    : $toolCount"
Write-Host "  LLM events     : $llmCount"
Write-Host "  Skill events   : $skillCount"
Write-Host "  MCP events     : $mcpCount"
if ($latestTs) {
    Write-Host "  Latest event   : $latestTs"
}
Write-Host ""

if ($sessions.Count -gt 0) {
    Write-Host "--- Sessions ---"
    foreach ($group in $sessions) {
        $sid = $group.Name
        $count = $group.Count
        $sessionEvents = $group.Group
        $agentTypes = ($sessionEvents | Where-Object { $_.agent_type } | Select-Object -First 1).agent_type
        $agentTypeStr = if ($agentTypes) { " ($agentTypes)" } else { '' }
        $firstTs = ($sessionEvents | Sort-Object { $_.t } | Select-Object -First 1).t
        $lastTs = ($sessionEvents | Sort-Object { $_.t } -Descending | Select-Object -First 1).t
        Write-Host "  $sid$agentTypeStr"
        Write-Host "    events: $count | range: $firstTs .. $lastTs"
    }
    Write-Host ""
}

if ($eventKinds.Count -gt 0) {
    Write-Host "--- Event Kinds ---"
    $sortedKinds = $eventKinds | Sort-Object Count -Descending
    foreach ($kind in $sortedKinds) {
        $name = $kind.Name
        if (-not $name) { $name = '(unknown)' }
        Write-Host "  $($kind.Count.ToString().PadLeft(5))  $name"
    }
    Write-Host ""
}

Write-Host "Spool base: $spoolBase"
