param(
    [string]$DevPort = "3000",
    [string]$GatewayPort = "18789"
)

$AgentInsightDir = "$env:USERPROFILE\.agent-insight"
$ProjectDir = "E:\桌面\agents_insight\agent-insight"
$ApiKey = "sk-cc64e7844786459ea46c65f8e19fcb79"
$GatewayToken = "3699932e339673c1d40a54a02cb9b5ea0de9c0426afc50dc"

Write-Host "=== OpenClaw Test Runner ===" -ForegroundColor Cyan

# ── 1. Kill old processes ──
Write-Host "[1/5] Cleaning old processes..." -ForegroundColor Yellow
Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*next*dev*$DevPort*" } | Stop-Process -Force -ErrorAction SilentlyContinue
Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*openclaw*gateway*" } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

# ── 2. Start Dev Server ──
Write-Host "[2/5] Starting Dev Server (port $DevPort)..." -ForegroundColor Yellow
$env:WITTY_API_KEY = $ApiKey
$env:NODE_OPTIONS = "--max-old-space-size=4096"
Set-Location $ProjectDir
$devProcess = Start-Process -FilePath "npx.cmd" -ArgumentList "next", "dev", "-p", $DevPort `
    -NoNewWindow -PassThru `
    -RedirectStandardOutput "$AgentInsightDir\logs\dev_server.log" `
    -RedirectStandardError "$AgentInsightDir\logs\dev_server.err"
Write-Host "   Dev Server PID: $($devProcess.Id)"

$ready = $false
for ($i = 1; $i -le 60; $i++) {
    Start-Sleep -Seconds 1
    try {
        $r = Invoke-WebRequest -Uri "http://localhost:$DevPort" -TimeoutSec 2 -UseBasicParsing
        if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch { }
}
if (-not $ready) { Write-Host "   WARN: Dev Server may not be ready" -ForegroundColor Red }
else { Write-Host "   OK: Dev Server ready" -ForegroundColor Green }

# ── 3. Start OpenClaw Gateway ──
Write-Host "[3/5] Starting OpenClaw Gateway (port $GatewayPort)..." -ForegroundColor Yellow
$gwProcess = Start-Process -FilePath "npx.cmd" -ArgumentList "-y", "@openclaw/gateway" `
    -NoNewWindow -PassThru `
    -RedirectStandardOutput "$AgentInsightDir\logs\gateway.log" `
    -RedirectStandardError "$AgentInsightDir\logs\gateway.err"
Write-Host "   Gateway PID: $($gwProcess.Id)"
Start-Sleep -Seconds 3

# ── 4. Test proxy connectivity ──
Write-Host "[4/5] Testing proxy connectivity..." -ForegroundColor Yellow
$testBody = '{"messages":[{"role":"user","content":"say ok"}],"model":"deepseek-chat"}'
try {
    $testResult = Invoke-WebRequest -Uri "http://localhost:$DevPort/api/proxy/v1/chat/completions" `
        -Method POST -Body $testBody -ContentType "application/json" `
        -Headers @{ "Authorization" = "Bearer $ApiKey" } -TimeoutSec 30 -UseBasicParsing
    $testData = $testResult.Content | ConvertFrom-Json
    Write-Host "   OK: $($testData.choices[0].message.content)" -ForegroundColor Green
}
catch {
    Write-Host "   FAIL: $_" -ForegroundColor Red
}

# ── 5. Send tool-call test request ──
Write-Host "[5/5] Sending tool-call test..." -ForegroundColor Yellow

# 5a: Gateway agent run
Write-Host "   (5a) Via Gateway..." -ForegroundColor Gray
$gwBody = '{"agent":"main","query":"write hello openclaw to a temp file using echo"}'
try {
    $gwResult = Invoke-WebRequest -Uri "http://localhost:$GatewayPort/api/v1/chat" `
        -Method POST -Body $gwBody -ContentType "application/json" `
        -Headers @{ "Authorization" = "Bearer $GatewayToken" } -TimeoutSec 120 -UseBasicParsing
    $gwData = $gwResult.Content | ConvertFrom-Json
    Write-Host "   OK: task $($gwData.task_id)" -ForegroundColor Green
}
catch {
    Write-Host "   SKIP: $($_.Exception.Message)" -ForegroundColor DarkYellow
}

# 5b: Direct proxy with tools
Write-Host "   (5b) Via Proxy (with tools param)..." -ForegroundColor Gray
$toolBody = '{"messages":[{"role":"user","content":"execute: echo hello"}],"model":"deepseek-chat","tools":[{"type":"function","function":{"name":"shell_exec","description":"Run a shell command","parameters":{"type":"object","properties":{"cmd":{"type":"string"}},"required":["cmd"]}}}]}'
try {
    $proxyResult = Invoke-WebRequest -Uri "http://localhost:$DevPort/api/proxy/v1/chat/completions" `
        -Method POST -Body $toolBody -ContentType "application/json" `
        -Headers @{ "Authorization" = "Bearer $ApiKey" } -TimeoutSec 60 -UseBasicParsing
    Write-Host "   OK: proxy tool request sent" -ForegroundColor Green
}
catch {
    Write-Host "   SKIP: $($_.Exception.Message)" -ForegroundColor DarkYellow
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host " All done!" -ForegroundColor Cyan
Write-Host " Dev Server:    http://localhost:$DevPort" -ForegroundColor White
Write-Host " Gateway:       http://localhost:$GatewayPort" -ForegroundColor White
Write-Host " Web UI (Trace): http://localhost:$DevPort/trace" -ForegroundColor White
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Check traces at http://localhost:$DevPort/trace" -ForegroundColor Green
Write-Host ""
Write-Host "Or check raw spool:" -ForegroundColor Gray
$today = Get-Date -Format yyyy-MM-dd
$spoolPath = "$AgentInsightDir\otel_data\traces\$today\traces.jsonl"
Write-Host "   Get-Content '$spoolPath' -Tail 5 | ConvertFrom-Json | Select-Object sessionId, kind, name, model, latencyMs" -ForegroundColor Gray
