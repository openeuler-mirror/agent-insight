param(
  [Parameter(Mandatory = $true)][string]$Repo,
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$NodeMirrorPrefix = 'swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/library/'
)

# Generates a single-Dockerfile variant of the repository's Dockerfile.local.
#
# Every fact that must match the repository is read from Dockerfile.local at build time,
# never hard-coded here:
#   - the Node image (and its tag) comes from the "FROM ... AS builder" line;
#   - the system package list is the union of the repo's two apt-get install blocks.
# Only the registry / apt / npm hosts are rewritten to domestic mirrors.
#
# The two apt blocks are replaced by one "base" stage that installs the same package set
# once; builder and runtime both start from it. If any expected pattern is gone, the script
# throws instead of generating a silently diverging Dockerfile.

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

function Get-AptPackages([string]$Block, [string]$Label) {
  $m = [regex]::Match($Block, 'apt-get install(?<body>[\s\S]*?)rm -rf /var/lib/apt/lists/\*')
  if (-not $m.Success) {
    throw "cannot parse package list from the $Label apt block"
  }
  $body = $m.Groups['body'].Value -replace '\\', ' ' -replace '&&', ' '
  $packages = @()
  foreach ($token in ($body -split '\s+')) {
    if ($token -match '^[a-z0-9][a-z0-9+.-]*$' -and $token -notin @('apt', 'get', 'update', 'install')) {
      $packages += $token
    }
  }
  if ($packages.Count -eq 0) {
    throw "no package found in the $Label apt block"
  }
  return $packages
}

$builderMatch = [regex]::Match($text, '(?m)^FROM\s+(?<img>\S+)\s+AS\s+builder\s*$')
if (-not $builderMatch.Success) {
  throw 'pattern not found: builder FROM. Expected "FROM <image> AS builder".'
}
$nodeRef = $builderMatch.Groups['img'].Value
if ($nodeRef.Contains('/')) {
  $mirrorRef = $nodeRef
} else {
  $mirrorRef = $NodeMirrorPrefix + $nodeRef
}

$oldAptBuilder = @(
  'RUN apt-get update \'
  '    && apt-get install -y --no-install-recommends openssl \'
  '    && rm -rf /var/lib/apt/lists/*'
) -join "`n"

$oldAptRuntime = @(
  'RUN apt-get update \'
  '    && apt-get install -y --no-install-recommends \'
  '        ca-certificates \'
  '        curl \'
  '        openssl \'
  '        python3 \'
  '    && rm -rf /var/lib/apt/lists/*'
) -join "`n"

$packages = @()
foreach ($pkg in (Get-AptPackages $oldAptBuilder 'builder')) {
  if ($packages -notcontains $pkg) { $packages += $pkg }
}
foreach ($pkg in (Get-AptPackages $oldAptRuntime 'runtime')) {
  if ($packages -notcontains $pkg) { $packages += $pkg }
}
$packageLine = '    && apt-get install -y --no-install-recommends ' + ($packages -join ' ') + ' \'

$newBase = @(
  'ARG APT_MIRROR=mirrors.huaweicloud.com'
  'ARG NPM_REGISTRY=https://repo.huaweicloud.com/repository/npm/'
  ''
  "FROM $mirrorRef AS base"
  ''
  'ARG APT_MIRROR'
  ''
  'RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \'
  '    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \'
  '    if [ -n "$APT_MIRROR" ] && [ -f /etc/apt/sources.list.d/debian.sources ]; then \'
  '        sed -i \'
  '            -e "s|http://deb.debian.org/debian-security|http://${APT_MIRROR}/debian-security|g" \'
  '            -e "s|http://deb.debian.org/debian|http://${APT_MIRROR}/debian|g" \'
  '            /etc/apt/sources.list.d/debian.sources; \'
  '    fi \'
  '    && apt-get update \'
  $packageLine
  '    && rm -rf /var/lib/apt/lists/*'
  ''
  'FROM base AS builder'
  ''
  'ARG NPM_REGISTRY'
  ''
  'ENV npm_config_registry=${NPM_REGISTRY}'
) -join "`n"

$text = Replace-Once $text $builderMatch.Value $newBase 'builder FROM'

$runtimeMatches = [regex]::Matches($text, '(?m)^FROM\s+(?<img>\S+)\s*$')
if ($runtimeMatches.Count -ne 1) {
  throw "expected exactly 1 single-image FROM line (runtime stage), found $($runtimeMatches.Count)"
}
if ($runtimeMatches[0].Groups['img'].Value -ne $nodeRef) {
  throw "runtime FROM image '$($runtimeMatches[0].Groups['img'].Value)' differs from builder image '$nodeRef'"
}
$text = [regex]::Replace($text, '(?m)^FROM\s+(?<img>\S+)\s*$', 'FROM base')

$oldNpm = 'RUN npm install --no-audit --no-fund'
$newNpm = @(
  '# Prisma 5.x downloads engines from binaries.prisma.sh, which is often blocked; use the mirror'
  'ENV PRISMA_ENGINES_MIRROR=https://registry.npmmirror.com/-/binary/prisma \'
  '    PRISMA_HIDE_UPDATE_MESSAGE=1'
  ''
  'RUN --mount=type=cache,target=/root/.npm \'
  '    npm install --no-audit --no-fund'
) -join "`n"

$oldBuild = @(
  'RUN npm run build \'
  '    && npm pack --pack-destination /tmp'
) -join "`n"
$newBuild = @(
  'RUN --mount=type=cache,target=/src/.next/cache \'
  '    npm run build && npm pack --pack-destination /tmp'
) -join "`n"

# The base stage already installs every system package, so both repo apt blocks go away.
$text = Replace-Once $text $oldAptBuilder '' 'builder apt-get'
$text = Replace-Once $text $oldAptRuntime '' 'runtime apt-get'
$text = Replace-Once $text $oldNpm $newNpm 'npm install'
$text = Replace-Once $text $oldBuild $newBuild 'npm run build'

$text = $text -replace "\n{3,}", "`n`n"

$header = @(
  '# AUTO-GENERATED from Dockerfile.local by make-dockerfile-single.ps1. DO NOT EDIT.'
  '# Single Dockerfile: one "base" stage installs the system packages once,'
  '# builder and runtime stages both start from it.'
  "# NODE_IMAGE=$mirrorRef"
  "# APT_PACKAGES=$($packages -join ' ')"
  ''
  ''
) -join "`n"
$text = $header + $text

if ($text -match '(?m)^FROM\s+node:') {
  throw 'hard-coded node image still used as a stage base'
}
$fromBase = ([regex]::Matches($text, [regex]::Escape('FROM base'))).Count
if ($fromBase -ne 2) {
  throw "expected 2 'FROM base' stages, found $fromBase"
}
$splitAt = $text.IndexOf('FROM base AS builder')
if ($splitAt -lt 0) {
  throw 'missing "FROM base AS builder" stage'
}
if ($text.Substring(0, $splitAt) -notmatch 'apt-get install') {
  throw 'base stage is missing the system package install'
}
if ($text.Substring($splitAt) -match 'apt-get') {
  throw 'apt-get still present after the base stage'
}

$outDir = Split-Path -Parent $Out
if ($outDir -and -not (Test-Path -LiteralPath $outDir)) {
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
}
[IO.File]::WriteAllText($Out, $text, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "generated $Out"
Write-Host "  node image : $mirrorRef"
Write-Host "  apt packages: $($packages -join ' ')"
