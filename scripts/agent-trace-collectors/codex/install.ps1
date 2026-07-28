$ErrorActionPreference = "Stop"

$baseUrl = if ($env:AGENT_INSIGHT_BASE_URL) {
    $env:AGENT_INSIGHT_BASE_URL.TrimEnd("/")
} else {
    "__AGENT_INSIGHT_BASE_URL__"
}
if (-not $env:AGENT_INSIGHT_API_KEY) {
    throw "AGENT_INSIGHT_API_KEY is required."
}

$assetUrl = "$baseUrl/api/ingest/setup/codex/assets"
$stageRoot = Join-Path ([IO.Path]::GetTempPath()) ("agent-insight-codex-" + [guid]::NewGuid().ToString("N"))
$sourceDir = Join-Path $stageRoot "codex"
$extensionDir = Join-Path $sourceDir "vscode-extension"
$sharedDir = Join-Path $stageRoot "shared"

try {
    New-Item -ItemType Directory -Force -Path $sourceDir | Out-Null
    New-Item -ItemType Directory -Force -Path $extensionDir | Out-Null
    New-Item -ItemType Directory -Force -Path $sharedDir | Out-Null

    $assets = @{
        "trace-transport.cjs" = Join-Path $sharedDir "trace-transport.cjs"
        "codex-trace-core.cjs" = Join-Path $sourceDir "codex-trace-core.cjs"
        "config-core.cjs" = Join-Path $sourceDir "config-core.cjs"
        "hook-handler.cjs" = Join-Path $sourceDir "hook-handler.cjs"
        "relay.cjs" = Join-Path $sourceDir "relay.cjs"
        "install.cjs" = Join-Path $sourceDir "install.cjs"
        "uninstall.cjs" = Join-Path $sourceDir "uninstall.cjs"
        "self-check.cjs" = Join-Path $sourceDir "self-check.cjs"
        "build-vsix.cjs" = Join-Path $sourceDir "build-vsix.cjs"
        "extension-package.json" = Join-Path $extensionDir "package.json"
        "extension.cjs" = Join-Path $extensionDir "extension.cjs"
        "ide-trace-core.cjs" = Join-Path $extensionDir "ide-trace-core.cjs"
        "extension.vsixmanifest" = Join-Path $extensionDir "extension.vsixmanifest"
        "Content_Types.xml" = Join-Path $extensionDir "[Content_Types].xml"
    }
    foreach ($asset in $assets.GetEnumerator()) {
        Invoke-WebRequest -UseBasicParsing -Uri "$assetUrl/$($asset.Key)" -OutFile $asset.Value
    }

    & node (Join-Path $sourceDir "install.cjs") --source-dir $sourceDir @args
    if ($LASTEXITCODE -ne 0) {
        throw "Codex installer exited with code $LASTEXITCODE."
    }
} finally {
    Remove-Item -LiteralPath $stageRoot -Recurse -Force -ErrorAction SilentlyContinue
}
