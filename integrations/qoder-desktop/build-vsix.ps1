$ErrorActionPreference = "Stop"

$IntegrationRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$RepositoryRoot = [IO.Path]::GetFullPath((Join-Path $IntegrationRoot "..\.."))
$BuildRoot = [IO.Path]::GetFullPath((Join-Path $IntegrationRoot "build"))
$Package = Get-Content -LiteralPath (Join-Path $IntegrationRoot "package.json") -Raw | ConvertFrom-Json
$Version = [string]$Package.version
$Stage = [IO.Path]::GetFullPath((Join-Path $BuildRoot "stage"))
$DistributionRoot = [IO.Path]::GetFullPath((Join-Path $BuildRoot "distributions"))
$Distribution = [IO.Path]::GetFullPath((Join-Path $DistributionRoot "agent-insight-qoder-desktop-$Version.vsix"))

foreach ($Target in @($Stage, $Distribution)) {
    if (-not $Target.StartsWith($BuildRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clean a path outside the extension build directory: $Target"
    }
    if (Test-Path -LiteralPath $Target) {
        Remove-Item -LiteralPath $Target -Recurse -Force
    }
}

New-Item -ItemType Directory -Force -Path $Stage, (Join-Path $Stage "collector"), $DistributionRoot | Out-Null
Copy-Item -LiteralPath (Join-Path $IntegrationRoot "package.json"), (Join-Path $IntegrationRoot "extension.js"), (Join-Path $IntegrationRoot "uninstall-watcher.mjs"), (Join-Path $RepositoryRoot "LICENSE") -Destination $Stage
Copy-Item -LiteralPath (Join-Path $RepositoryRoot "scripts\qoder_trace_collector.mjs"), (Join-Path $RepositoryRoot "scripts\qoder_uploader_client.mjs"), (Join-Path $RepositoryRoot "scripts\qoder_setup.mjs"), (Join-Path $RepositoryRoot "scripts\qoder_token_usage_env.mjs") -Destination (Join-Path $Stage "collector")

Push-Location $Stage
try {
    & npx.cmd --yes '@vscode/vsce' package --no-dependencies --out $Distribution
    if ($LASTEXITCODE -ne 0) { throw "VSIX packaging failed." }
} finally {
    Pop-Location
}

Write-Output $Distribution
