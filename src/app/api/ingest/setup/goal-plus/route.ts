/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { NextResponse } from 'next/server';
import { goalPlusCollectorBundle } from './bundle';

function publicOrigin(request: Request): string {
  const url = new URL(request.url);
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || url.host;
  const protocol = request.headers.get('x-forwarded-proto') || url.protocol.replace(':', '');
  return `${protocol}://${host}`;
}

function bashSingleQuoted(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
function psSingleQuoted(value: string): string { return `'${value.replaceAll("'", "''")}'`; }

export async function GET(request: Request) {
  const windows = request.headers.get('x-platform')?.toLowerCase() === 'windows'
    || request.headers.get('user-agent')?.toLowerCase().includes('windows');
  const origin = publicOrigin(request);
  const sha256 = goalPlusCollectorBundle().sha256;
  const assetUrl = `${origin}/api/ingest/setup/goal-plus/assets/goal-plus-collector.zip`;
  if (windows) {
    const source = [
      '$ErrorActionPreference = "Stop"',
      'if (-not $env:AGENT_INSIGHT_API_KEY) { throw "AGENT_INSIGHT_API_KEY is required" }',
      'if ([version](node -p "process.versions.node") -lt [version]"22.19.0") { throw "Node.js >=22.19.0 is required" }',
      `$AssetUrl = ${psSingleQuoted(assetUrl)}`,
      `$ExpectedSha256 = ${psSingleQuoted(sha256)}`,
      '$Stage = Join-Path ([IO.Path]::GetTempPath()) ("agent-insight-goal-plus-" + [guid]::NewGuid().ToString("N"))',
      'New-Item -ItemType Directory -Path $Stage | Out-Null',
      'try {',
      '  $Archive = Join-Path $Stage "goal-plus-collector.zip"',
      '  Invoke-WebRequest -UseBasicParsing -Uri $AssetUrl -OutFile $Archive',
      '  $ActualSha256 = (Get-FileHash -Algorithm SHA256 $Archive).Hash.ToLowerInvariant()',
      '  if ($ActualSha256 -ne $ExpectedSha256) { throw "Goal Plus collector bundle SHA-256 mismatch" }',
      '  Expand-Archive -Path $Archive -DestinationPath $Stage',
      `  $env:AGENT_INSIGHT_BASE_URL = ${psSingleQuoted(origin)}`,
      '  & node (Join-Path $Stage "goal-plus/install.cjs") --source-dir (Join-Path $Stage "goal-plus")',
      '  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
      '} finally { Remove-Item -Recurse -Force $Stage -ErrorAction SilentlyContinue }',
    ].join('\r\n');
    return new NextResponse(source, { headers: { 'Content-Type': 'application/x-powershell; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  }
  const source = [
    '#!/bin/sh',
    'set -eu',
    ': "${AGENT_INSIGHT_API_KEY:?AGENT_INSIGHT_API_KEY is required}"',
    'node -e \'const [major,minor]=process.versions.node.split(".").map(Number);if(major<22||(major===22&&minor<19))process.exit(1)\' || { echo "Node.js >=22.19.0 is required" >&2; exit 1; }',
    `ASSET_URL=${bashSingleQuoted(assetUrl)}`,
    `EXPECTED_SHA256=${bashSingleQuoted(sha256)}`,
    'STAGE_DIR="$(mktemp -d)"',
    'trap \'rm -rf "$STAGE_DIR"\' EXIT HUP INT TERM',
    'curl -fsSL "$ASSET_URL" -o "$STAGE_DIR/goal-plus-collector.zip"',
    'ACTUAL_SHA256="$(shasum -a 256 "$STAGE_DIR/goal-plus-collector.zip" | awk \'{print $1}\')"',
    '[ "$ACTUAL_SHA256" = "$EXPECTED_SHA256" ] || { echo "Goal Plus collector bundle SHA-256 mismatch" >&2; exit 1; }',
    'unzip -q "$STAGE_DIR/goal-plus-collector.zip" -d "$STAGE_DIR"',
    `AGENT_INSIGHT_BASE_URL=${bashSingleQuoted(origin)} node "$STAGE_DIR/goal-plus/install.cjs" --source-dir "$STAGE_DIR/goal-plus"`,
  ].join('\n');
  return new NextResponse(source, { headers: { 'Content-Type': 'text/x-shellscript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
