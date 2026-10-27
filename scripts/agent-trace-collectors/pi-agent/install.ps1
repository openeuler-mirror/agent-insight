# Copyright (c) 2026 Huawei Technologies Co., Ltd.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

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
