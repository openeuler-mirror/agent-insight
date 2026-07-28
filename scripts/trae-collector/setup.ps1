# Agent Insight TRAE Collector - Windows Setup
# Deploys PowerShell hook scripts and generates hooks.json for native Windows TRAE.
# No WSL required.

$ErrorActionPreference = 'Continue'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$HookSrc = Join-Path $ScriptDir "hooks"
$InsightDir = if ($env:AGENT_INSIGHT_DIR) { $env:AGENT_INSIGHT_DIR } else { Join-Path $env:USERPROFILE ".agent-insight" }
$TraeHookDir = Join-Path $InsightDir "trae-hooks"
$TraeCnDir = Join-Path $env:USERPROFILE ".trae-cn"

Write-Host "Agent Insight TRAE Collector - Windows Setup"
Write-Host "============================================="

# Step 1: Copy PowerShell hook scripts
Write-Host "[1/4] Installing PowerShell hook scripts to $TraeHookDir..."
$null = New-Item -ItemType Directory -Path (Join-Path $TraeHookDir "scripts") -Force
$null = New-Item -ItemType Directory -Path (Join-Path $TraeHookDir "lib") -Force
Copy-Item (Join-Path $HookSrc "ps1\scripts\*.ps1") (Join-Path $TraeHookDir "scripts") -Force
Copy-Item (Join-Path $HookSrc "ps1\lib\*.ps1") (Join-Path $TraeHookDir "lib") -Force
Write-Host "   [OK] PowerShell hook scripts installed"

# Step 2: Create TRAE hooks.json from Windows template
Write-Host "[2/4] Creating TRAE hook configuration..."
$null = New-Item -ItemType Directory -Path $TraeCnDir -Force
$templatePath = Join-Path $HookSrc "hooks-windows.json"
if (-not (Test-Path $templatePath)) {
    Write-Host "   [WARN] hooks-windows.json not found, falling back to hooks.json"
    $templatePath = Join-Path $HookSrc "hooks.json"
}
$templateContent = Get-Content $templatePath -Raw
$escapedPath = $TraeHookDir -replace '\\', '\\'
$hooksContent = $templateContent -replace '__HOOK_DIR__', $escapedPath
$hooksJsonPath = Join-Path $TraeCnDir "hooks.json"
# Write UTF-8 without BOM (PowerShell Set-Content -Encoding UTF8 adds BOM which breaks TRAE parser)
[System.IO.File]::WriteAllText($hooksJsonPath, $hooksContent, [System.Text.UTF8Encoding]::new($false))
Write-Host "   [OK] TRAE hooks.json created at $TraeCnDir\hooks.json"

# Step 3: Ensure spool directories
Write-Host "[3/4] Ensuring spool directories..."
$spoolDir = Join-Path $InsightDir "otel_data\trae"
$logDir = Join-Path $InsightDir "logs"
$null = New-Item -ItemType Directory -Path $spoolDir -Force
$null = New-Item -ItemType Directory -Path $logDir -Force
Write-Host "   [OK] Spool directory: $spoolDir"

# Step 4: Cleanup old spool data (>7 days)
Write-Host "[4/4] Cleaning old spool data (>7 days)..."
$cutoff = (Get-Date).AddDays(-7)
Get-ChildItem -Path $spoolDir -Directory | Where-Object { $_.LastWriteTime -lt $cutoff } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "   [OK] Old spool cleaned"

Write-Host ""
Write-Host "Setup complete!"
Write-Host ""
Write-Host "Summary:"
Write-Host "   Hook scripts:  $TraeHookDir\"
Write-Host "   TRAE config:   $TraeCnDir\hooks.json"
Write-Host "   Spool dir:     $spoolDir"
Write-Host ""
Write-Host "Next steps:"
Write-Host "   1. Restart TRAE IDE for hooks to take effect"
Write-Host "   2. Check hook logs in TRAE: Settings -> Hooks -> Logs"
Write-Host "   3. The VS Code Extension handles:"
Write-Host "      - Upload spool data to server"
Write-Host "      - LLM model/token collection (if available)"
Write-Host "      - Status bar collection status"
