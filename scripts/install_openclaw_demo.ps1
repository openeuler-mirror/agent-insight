#!/usr/bin/env pwsh
<#
.SYNOPSIS
  One-command install: agent-insight OpenClaw OTel integration for demo.
  Run this AFTER the dev server is already started (npx next dev -p 3000).
#>
param([string]$DevPort = "3000")

$ErrorActionPreference = "Stop"
$host.ui.RawUI.WindowTitle = "agent-insight OpenClaw Demo Installer"

Write-Host "=== agent-insight OpenClaw Demo Install ===" -ForegroundColor Cyan
Write-Host ""

# ── 1. Check dev server ──
Write-Host "[1/4] Checking dev server on port $DevPort..." -ForegroundColor Yellow
try {
  $null = Invoke-WebRequest -Uri "http://localhost:$DevPort" -TimeoutSec 3 -UseBasicParsing
  Write-Host "   OK: Dev server is running" -ForegroundColor Green
} catch {
  Write-Host "   ERROR: Dev server not reachable on port $DevPort" -ForegroundColor Red
  Write-Host "   Start it first: cd <project>; npx next dev -p $DevPort" -ForegroundColor Yellow
  exit 1
}

# ── 2. Fetch the full install script from the setup API ──
Write-Host "[2/4] Fetching install script from setup API..." -ForegroundColor Yellow
try {
  $setupScript = Invoke-WebRequest -Uri "http://localhost:$DevPort/api/ingest/setup" `
    -Headers @{"x-platform" = "windows"} -UseBasicParsing | Select-Object -ExpandProperty Content
} catch {
  Write-Host "   ERROR: Failed to fetch setup script: $_" -ForegroundColor Red
  exit 1
}

$setupPath = "$env:TEMP\agent_insight_full_install.ps1"
$setupScript | Out-File -FilePath $setupPath -Encoding utf8

# ── 3. Patch the script to auto-select OpenClaw (skip interactive picker) ──
Write-Host "[3/4] Pre-configuring OpenClaw selection..." -ForegroundColor Yellow
# Read back as lines
$lines = Get-Content $setupPath

# Find and replace the interactive selector call with a direct result
$patched = $false
for ($i = 0; $i -lt $lines.Count; $i++) {
  # Replace the line that calls the framework selector mjs
  if ($lines[$i] -match 'node.*framework_selector\.mjs') {
    # Write openclaw-only result and skip the interactive step
    Write-Host "   Patching line $i: bypassing interactive selector" -ForegroundColor Gray
    $patched = $true
    # Insert the selector result directly before the selector call
    $lines[$i] = "# [patched] selector result: openclaw only"
    break
  }
}

# Actually, the selector result is read from file. Let's instead pre-write the result file.
# The selector writes to $SELECTOR_RESULT. We'll inject the result manually.
# Looking at the script flow: it runs framework_selector.mjs which writes to .selector_result
# Then it reads .selector_result to get $SELECTED_FRAMEWORKS

# Strategy: find the line that says "node" framework_selector.mjs and replace with
# code that writes 'openclaw' to the result file instead
$selectorResultLine = $null
$selectorResultVar = '$SELECTOR_RESULT'
for ($i = 0; $i -lt $lines.Count; $i++) {
  if ($lines[$i] -match 'node.*framework_selector\.mjs') {
    $selectorResultLine = $i
    break
  }
}

if ($selectorResultLine) {
  # Replace the interactive selector with a hardcoded openclaw selection
  $oldLine = $lines[$selectorResultLine]
  # Indent preserved
  $indent = $oldLine -replace '^( *).*', '$1'
  $lines[$selectorResultLine] = "${indent}Write-Host '   [auto-selected] OpenClaw' -ForegroundColor Cyan"
  
  # Find the line AFTER the selector that reads the result
  $insertAt = $selectorResultLine + 1
  # Insert Set-Content for SELECTED_FRAMEWORKS before the reading line
  $lines[$insertAt] = "${indent}`$SELECTED_FRAMEWORKS = 'openclaw'"
  $lines[$insertAt+1] = "${indent}Write-Host '   Frameworks: `$SELECTED_FRAMEWORKS'"
  
  Write-Host "   Patched to auto-select OpenClaw" -ForegroundColor Green
} else {
  Write-Host "   WARNING: Could not find selector line, script may still be interactive" -ForegroundColor Yellow
}

# Also skip Claude install if it fails or asks
# The script checks node version and creates dirs - those are all fine

$setupPath = "$env:TEMP\agent_insight_demo_install.ps1"
$lines | Out-File -FilePath $setupPath -Encoding utf8

# ── 4. Run the install script ──
Write-Host "[4/4] Running install script..." -ForegroundColor Yellow
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "The install script will now run." -ForegroundColor Cyan
Write-Host "Press Enter to continue or Ctrl+C to abort..." -ForegroundColor Gray
Write-Host "========================================" -ForegroundColor Cyan
$null = Read-Host

& $setupPath

Write-Host ""
Write-Host "=== Install Complete ===" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Restart PowerShell or run: . `"$env:USERPROFILE\.agent-insight\openclaw_otel_env.ps1`"" -ForegroundColor White
Write-Host "  2. Start OpenClaw gateway: openclaw gateway run --port 18789 --force" -ForegroundColor White
Write-Host "  3. Run a task: openclaw tui (or openclaw agent --message '...')" -ForegroundColor White
Write-Host "  4. Open browser: http://localhost:$DevPort" -ForegroundColor White
