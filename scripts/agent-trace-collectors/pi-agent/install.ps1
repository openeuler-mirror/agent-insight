$ErrorActionPreference = "Stop"

$baseUrl = if ($env:AGENT_INSIGHT_BASE_URL) {
    $env:AGENT_INSIGHT_BASE_URL.TrimEnd("/")
} else {
    "__AGENT_INSIGHT_BASE_URL__"
}
if (-not $env:AGENT_INSIGHT_API_KEY) {
    throw "AGENT_INSIGHT_API_KEY is required."
}

$bundleUrl = "$baseUrl/api/ingest/setup/pi-agent/assets/pi-agent-bundle.zip"
$expectedBundleSha256 = "__PI_AGENT_BUNDLE_SHA256__"
$stageRoot = Join-Path ([IO.Path]::GetTempPath()) ("agent-insight-pi-" + [guid]::NewGuid().ToString("N"))
$sourceDir = Join-Path $stageRoot "pi-agent"
$bundlePath = Join-Path $stageRoot "pi-agent-bundle.zip"

try {
    New-Item -ItemType Directory -Force -Path $stageRoot | Out-Null
    Invoke-WebRequest -UseBasicParsing -Uri $bundleUrl -OutFile $bundlePath
    $actualBundleSha256 = (Get-FileHash -LiteralPath $bundlePath -Algorithm SHA256).Hash
    if (-not [StringComparer]::OrdinalIgnoreCase.Equals($actualBundleSha256, $expectedBundleSha256)) {
        throw "Pi Agent collector bundle SHA-256 mismatch."
    }
    Expand-Archive -LiteralPath $bundlePath -DestinationPath $stageRoot -Force
    if (-not (Test-Path -LiteralPath (Join-Path $sourceDir "install.cjs") -PathType Leaf)) {
        throw "Pi Agent collector bundle is incomplete."
    }

    & node (Join-Path $sourceDir "install.cjs") --source-dir $sourceDir @args
    if ($LASTEXITCODE -ne 0) {
        throw "Pi Agent installer exited with code $LASTEXITCODE."
    }
} finally {
    Remove-Item -LiteralPath $stageRoot -Recurse -Force -ErrorAction SilentlyContinue
}
