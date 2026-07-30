param(
    [string]$IdeHome = $env:JETBRAINS_HOME
)

$ErrorActionPreference = "Stop"
$Builder = Join-Path $PSScriptRoot "build-plugin.mjs"
$BuilderArgs = @()
if (-not [string]::IsNullOrWhiteSpace($IdeHome)) {
    $BuilderArgs += @("--ide-home", $IdeHome)
}
& node $Builder @BuilderArgs @args
if ($LASTEXITCODE -ne 0) { throw "JetBrains plugin packaging failed." }
