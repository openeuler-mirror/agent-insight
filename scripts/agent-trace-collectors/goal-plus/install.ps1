$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
& node (Join-Path $Here "install.cjs") @args
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
