<#
  opencode-offline-fix.ps1
  Purpose: make bun's npm-registry request FAIL FAST, so opencode desktop does not
           hang at "connecting to local server" while trying to install
           @opencode-ai/plugin@local over the network (~60s timeout when offline).
  Behavior: auto-detects whether npm is directly reachable; only applies the fix
            when it is NOT; fully reversible.

  Usage (download then run, so parameters work):
    irm "http://<platform-host>:3000/api/setup/opencode-offline-fix" -OutFile opencode-offline-fix.ps1
    powershell -ExecutionPolicy Bypass -File .\opencode-offline-fix.ps1            # detect; apply only if npm unreachable
    powershell -ExecutionPolicy Bypass -File .\opencode-offline-fix.ps1 -Force     # skip detection, apply anyway
    powershell -ExecutionPolicy Bypass -File .\opencode-offline-fix.ps1 -Restore   # undo, restore original state
    powershell -ExecutionPolicy Bypass -File .\opencode-offline-fix.ps1 -Registry "http://your-intranet-mirror/"
                                          # use an internal npm mirror instead of the
                                          # dead address (real npm installs still work)
#>
param(
  [switch]$Restore,
  [switch]$Force,
  [string]$Registry = "http://127.0.0.1:1/"
)
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$ErrorActionPreference = "Continue"

$npmrc  = Join-Path $env:USERPROFILE ".npmrc"
$backup = Join-Path $env:USERPROFILE ".npmrc.agent-insight-bak"
$bunfig = Join-Path $env:USERPROFILE ".config\opencode\bunfig.toml"
$marker = "# agent-insight-opencode-offline-fix"

function Test-NpmReachable {
  # Direct TCP connect (does NOT use system proxy) -> mirrors how bun reaches npm.
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $iar = $c.BeginConnect("registry.npmjs.org", 443, $null, $null)
    $ok = $iar.AsyncWaitHandle.WaitOne(3000, $false)
    $connected = $ok -and $c.Connected
    $c.Close()
    return $connected
  } catch { return $false }
}

# ---------------- RESTORE ----------------
if ($Restore) {
  if (Test-Path $backup) {
    Move-Item -LiteralPath $backup -Destination $npmrc -Force
    Write-Host "[restore] restored original .npmrc from backup"
  } elseif (Test-Path $npmrc) {
    if ((Get-Content $npmrc -Raw) -match [regex]::Escape($marker)) {
      Remove-Item $npmrc -Force
      Write-Host "[restore] removed the .npmrc created by this script"
    } else {
      Write-Host "[restore] current .npmrc was NOT created by this script (no marker); left untouched: $npmrc"
    }
  } else {
    Write-Host "[restore] nothing to restore"
  }
  if ((Test-Path $bunfig) -and ((Get-Content $bunfig -Raw) -match "127\.0\.0\.1:1")) {
    Remove-Item $bunfig -Force
    Write-Host "[restore] removed leftover test bunfig.toml"
  }
  Write-Host "[restore] done. Fully quit and reopen opencode desktop."
  return
}

# ---------------- DETECT ----------------
if (-not $Force) {
  Write-Host "[detect] testing direct connection to registry.npmjs.org:443 ..."
  if (Test-NpmReachable) {
    Write-Host "[detect] npm is REACHABLE -> opencode's dependency install returns fast, no hang."
    Write-Host "[detect] fix NOT needed. Use -Force to apply anyway."
    return
  }
  Write-Host "[detect] npm is NOT reachable (offline / intranet / proxy) -> opencode will hang -> applying fix."
}

# ---------------- APPLY ----------------
if ((Test-Path $npmrc) -and (-not (Test-Path $backup))) {
  if (-not ((Get-Content $npmrc -Raw) -match [regex]::Escape($marker))) {
    Copy-Item $npmrc $backup -Force
    Write-Host "[apply] backed up original .npmrc -> $backup"
  }
}
$body = @"
$marker
registry=$Registry
fetch-retries=0
fetch-timeout=2000
"@
Set-Content -Path $npmrc -Value $body -Encoding ascii
Write-Host "[apply] wrote fast-fail config: $npmrc  (registry=$Registry)"
Write-Host "[apply] now FULLY quit and reopen opencode desktop; it should open instantly with the plugin uploading."
Write-Host "[apply] to undo: powershell -ExecutionPolicy Bypass -File .\opencode-offline-fix.ps1 -Restore"
