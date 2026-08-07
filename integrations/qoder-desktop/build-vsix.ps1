$ErrorActionPreference = "Stop"
$Builder = Join-Path $PSScriptRoot "build-vsix.mjs"
& node $Builder @args
if ($LASTEXITCODE -ne 0) { throw "VSIX packaging failed." }
