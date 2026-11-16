param(
  [Parameter(Mandatory = $true)][string]$Repo,
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$NodeMirrorPrefix = 'swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/library/'
)

# Builds Dockerfile.agent-insight.single from the repository Dockerfile.local.
#
# Only the download hosts are rewritten (node image, deb.debian.org, npm, prisma).
# On top of that the stages are split so Docker's layer cache survives a code change:
#   deps     - package files only + npm install; unchanged deps stay cached
#   builder  - FROM deps + source + npm run build
# node_modules still comes from the builder stage: whatever the build writes into it
# (prisma client, patched binaries) must land in the image, so it is not taken from deps.
# The build id (ARG/LABEL/ENV, metadata only) is emitted right before CMD, so a new
# timestamp no longer invalidates the expensive runtime layers.
# Every anchor must match Dockerfile.local, otherwise this throws.

$ErrorActionPreference = 'Stop'

$src = Join-Path $Repo 'Dockerfile.local'
if (-not (Test-Path -LiteralPath $src)) {
  throw "missing $src"
}

$text = [IO.File]::ReadAllText($src) -replace "`r`n", "`n"

function Replace-Once([string]$Text, [string]$Old, [string]$New, [string]$Label) {
  if (-not $Text.Contains($Old)) {
    throw "pattern not found: $Label. Re-align make-dockerfile-single.ps1 with Dockerfile.local."
  }
  return $Text.Replace($Old, $New)
}

# --- node image -----------------------------------------------------------
$fromMatches = [regex]::Matches($text, '(?m)^FROM\s+(?<img>[^\s]+)')
if ($fromMatches.Count -eq 0) {
  throw 'pattern not found: FROM'
}
$refs = @()
foreach ($m in $fromMatches) { $refs += $m.Groups['img'].Value }
$uniqueRefs = @($refs | Select-Object -Unique)
if ($uniqueRefs.Count -ne 1) {
  throw "Dockerfile.local uses more than one base image: $($uniqueRefs -join ', ')"
}
$nodeRef = $uniqueRefs[0]
$mirrorRef = if ($nodeRef.Contains('/')) { $nodeRef } else { $NodeMirrorPrefix + $nodeRef }

# --- apt ------------------------------------------------------------------
$aptOld = 'RUN apt-get update \'
$aptNew = @(
  'ARG APT_MIRROR=mirrors.huaweicloud.com'
  ''
  'RUN if [ -n "$APT_MIRROR" ] && [ -f /etc/apt/sources.list.d/debian.sources ]; then \'
  '        sed -i \'
  '            -e "s|http://deb.debian.org/debian-security|http://${APT_MIRROR}/debian-security|g" \'
  '            -e "s|http://deb.debian.org/debian|http://${APT_MIRROR}/debian|g" \'
  '            /etc/apt/sources.list.d/debian.sources; \'
  '    fi \'
  '    && apt-get update \'
) -join "`n"
$aptCount = ([regex]::Matches($text, [regex]::Escape($aptOld))).Count
if ($aptCount -ne 2) {
  throw "expected 2 apt-get update blocks in Dockerfile.local, found $aptCount"
}
$text = $text.Replace($aptOld, $aptNew)

# --- npm / prisma ---------------------------------------------------------
$npmOld = 'RUN npm install --no-audit --no-fund'
$npmNew = @(
  'ARG NPM_REGISTRY=https://repo.huaweicloud.com/repository/npm/'
  ''
  '# Prisma downloads its engines from binaries.prisma.sh, which is often unreachable here'
  'ENV npm_config_registry=${NPM_REGISTRY} \'
  '    npm_config_fetch_retries=5 \'
  '    npm_config_fetch_retry_mintimeout=20000 \'
  '    npm_config_fetch_retry_maxtimeout=120000 \'
  '    npm_config_fetch_timeout=600000 \'
  '    PRISMA_ENGINES_MIRROR=https://registry.npmmirror.com/-/binary/prisma \'
  '    PRISMA_HIDE_UPDATE_MESSAGE=1'
  ''
  'RUN npm install --no-audit --no-fund'
) -join "`n"
$text = Replace-Once $text $npmOld $npmNew 'npm install'

# --- stage split ----------------------------------------------------------
# Everything up to "COPY . ." (package files, scripts, prisma, npm install) becomes
# the deps stage; the source copy starts the builder stage.
$text = Replace-Once $text "FROM $nodeRef AS builder" "FROM $mirrorRef AS deps" 'builder FROM'
$text = Replace-Once $text "COPY . .`n" "FROM deps AS builder`n`nCOPY . .`n" 'COPY . .'

# --- runtime FROM ---------------------------------------------------------
$runtimeFrom = "FROM $nodeRef"
$text = Replace-Once $text $runtimeFrom "FROM $mirrorRef" 'runtime FROM'

# --- build id: move the metadata to the end -------------------------------
# Otherwise a new timestamp invalidates every layer below the LABEL.
$labelBlock = @(
  'ARG LOCAL_BUILD_ID=local'
  ''
  'LABEL org.opencontainers.image.title="Agent Insight local build" \'
  '      org.opencontainers.image.version="${LOCAL_BUILD_ID}" \'
  '      org.opencontainers.image.source="local-worktree"'
) -join "`n"
$text = Replace-Once $text $labelBlock '' 'LOCAL_BUILD_ID label'

$buildEnvOld = "    AGENT_INSIGHT_BUILD_ID=`${LOCAL_BUILD_ID} \`n"
$text = Replace-Once $text $buildEnvOld '' 'AGENT_INSIGHT_BUILD_ID env'

$cmdLine = 'CMD ["agent-insight-entrypoint"]'
$cmdNew = @(
  'ARG LOCAL_BUILD_ID=local'
  ''
  'ENV AGENT_INSIGHT_BUILD_ID=${LOCAL_BUILD_ID}'
  ''
  'LABEL org.opencontainers.image.title="Agent Insight local build" \'
  '      org.opencontainers.image.version="${LOCAL_BUILD_ID}" \'
  '      org.opencontainers.image.source="local-worktree"'
  ''
  'CMD ["agent-insight-entrypoint"]'
) -join "`n"
if (-not $text.Contains($cmdLine)) {
  throw "pattern not found: $cmdLine"
}
$text = $text.Replace($cmdLine, $cmdNew)

# --- header ---------------------------------------------------------------
$header = @(
  '# AUTO-GENERATED from Dockerfile.local by make-dockerfile-single.ps1. DO NOT EDIT.'
  '# Download hosts point at domestic mirrors; the stage split and the trailing build id'
  '# exist so a code change does not throw away the dependency layers.'
  "# NODE_IMAGE=$mirrorRef"
  ''
  ''
) -join "`n"
$text = $header + $text

# --- assertions -----------------------------------------------------------
if ($text -match '(?m)^FROM\s+node:') {
  throw 'node image still points at Docker Hub'
}
$text = $text -replace "\n{3,}", "`n`n"
if (-not $text.Contains('FROM deps AS builder')) { throw 'missing "FROM deps AS builder" stage' }
if (-not $text.Contains('COPY --from=builder /src/node_modules')) { throw 'node_modules must come from the builder stage, not deps' }
$depsAt = $text.IndexOf('AS deps')
$builderAt = $text.IndexOf('FROM deps AS builder')
$npmInstallAt = $text.IndexOf('RUN npm install --no-audit --no-fund')
$buildAt = $text.IndexOf('npm run build')
$argAt = $text.IndexOf('ARG LOCAL_BUILD_ID=local')
$chmodAt = $text.IndexOf('chmod +x /usr/local/bin/agent-insight-entrypoint')
if ($depsAt -lt 0 -or $builderAt -lt 0 -or $npmInstallAt -lt 0 -or $buildAt -lt 0 -or $argAt -lt 0 -or $chmodAt -lt 0) {
  throw 'generated Dockerfile is missing an expected anchor'
}
if (-not ($depsAt -lt $npmInstallAt -and $npmInstallAt -lt $builderAt -and $builderAt -lt $buildAt)) {
  throw 'npm install is not inside the deps stage or the builder stage is out of order'
}
if ($argAt -lt $chmodAt) {
  throw 'LOCAL_BUILD_ID metadata must come after the runtime setup layers'
}

$outDir = Split-Path -Parent $Out
if ($outDir -and -not (Test-Path -LiteralPath $outDir)) {
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
}
[IO.File]::WriteAllText($Out, $text, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "generated $Out"
Write-Host "  node image: $mirrorRef"
