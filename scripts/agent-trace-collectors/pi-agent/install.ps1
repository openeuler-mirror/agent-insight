$ErrorActionPreference = "Stop"

$baseUrl = if ($env:AGENT_INSIGHT_BASE_URL) {
    $env:AGENT_INSIGHT_BASE_URL.TrimEnd("/")
} else {
    "__AGENT_INSIGHT_BASE_URL__"
}
if (-not $env:AGENT_INSIGHT_API_KEY) {
    throw "AGENT_INSIGHT_API_KEY is required."
}

$assetUrl = "$baseUrl/api/ingest/setup/pi-agent/assets"
$stageRoot = Join-Path ([IO.Path]::GetTempPath()) ("agent-insight-pi-" + [guid]::NewGuid().ToString("N"))
$sourceDir = Join-Path $stageRoot "pi-agent"
$sharedDir = Join-Path $stageRoot "shared"

try {
    New-Item -ItemType Directory -Force -Path (Join-Path $sourceDir "extensions") | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $sourceDir "lib") | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $sourceDir "scripts") | Out-Null
    New-Item -ItemType Directory -Force -Path $sharedDir | Out-Null

    $assets = @{
        "package.json" = Join-Path $sourceDir "package.json"
        "pi-agent-insight.ts" = Join-Path $sourceDir "extensions\pi-agent-insight.ts"
        "pi-trace-core.cjs" = Join-Path $sourceDir "lib\pi-trace-core.cjs"
        "self-check.cjs" = Join-Path $sourceDir "scripts\self-check.cjs"
        "uninstall.cjs" = Join-Path $sourceDir "scripts\uninstall.cjs"
        "install.cjs" = Join-Path $sourceDir "install.cjs"
        "trace-transport.cjs" = Join-Path $sharedDir "trace-transport.cjs"
    }
    foreach ($asset in $assets.GetEnumerator()) {
        Invoke-WebRequest -UseBasicParsing -Uri "$assetUrl/$($asset.Key)" -OutFile $asset.Value
    }

    & node (Join-Path $sourceDir "install.cjs") --source-dir $sourceDir @args
    if ($LASTEXITCODE -ne 0) {
        throw "Pi Agent installer exited with code $LASTEXITCODE."
    }
} finally {
    Remove-Item -LiteralPath $stageRoot -Recurse -Force -ErrorAction SilentlyContinue
}
