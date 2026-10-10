import { NextResponse } from 'next/server';

import { mctsXgovernorCollectorBundle } from './bundle';

function publicOrigin(request: Request): string {
  const url = new URL(request.url);
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || url.host;
  const protocol = request.headers.get('x-forwarded-proto') || url.protocol.replace(':', '');
  return `${protocol}://${host}`;
}

function bashSingleQuoted(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function GET(request: Request) {
  const windows = request.headers.get('x-platform')?.toLowerCase() === 'windows'
    || request.headers.get('user-agent')?.toLowerCase().includes('windows');
  if (windows) {
    return new NextResponse('MCTS xGovernor collector requires Linux or macOS. Use WSL on Windows.', {
      status: 400,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
  const origin = publicOrigin(request);
  const sha256 = mctsXgovernorCollectorBundle().sha256;
  const assetUrl = `${origin}/api/ingest/setup/mcts-xgovernor/assets/mcts-xgovernor-collector.zip`;
  const source = [
    '#!/bin/sh',
    'set -eu',
    ': "${AGENT_INSIGHT_API_KEY:?AGENT_INSIGHT_API_KEY is required}"',
    'node -e \'const [major,minor]=process.versions.node.split(".").map(Number);if(major<22||(major===22&&minor<19))process.exit(1)\' || { echo "Node.js >=22.19.0 is required" >&2; exit 1; }',
    `ASSET_URL=${bashSingleQuoted(assetUrl)}`,
    `EXPECTED_SHA256=${bashSingleQuoted(sha256)}`,
    'STAGE_DIR="$(mktemp -d)"',
    'trap \'rm -rf "$STAGE_DIR"\' EXIT HUP INT TERM',
    'curl -fsSL "$ASSET_URL" -o "$STAGE_DIR/mcts-xgovernor-collector.zip"',
    'if command -v sha256sum >/dev/null 2>&1; then ACTUAL_SHA256="$(sha256sum "$STAGE_DIR/mcts-xgovernor-collector.zip" | awk \'{print $1}\')"; else ACTUAL_SHA256="$(shasum -a 256 "$STAGE_DIR/mcts-xgovernor-collector.zip" | awk \'{print $1}\')"; fi',
    '[ "$ACTUAL_SHA256" = "$EXPECTED_SHA256" ] || { echo "MCTS xGovernor collector bundle SHA-256 mismatch" >&2; exit 1; }',
    'unzip -q "$STAGE_DIR/mcts-xgovernor-collector.zip" -d "$STAGE_DIR"',
    `AGENT_INSIGHT_BASE_URL=${bashSingleQuoted(origin)} node "$STAGE_DIR/mcts-xgovernor-proxy/install.cjs" --source-dir "$STAGE_DIR/mcts-xgovernor-proxy"`,
  ].join('\n');
  return new NextResponse(source, {
    headers: {
      'Content-Type': 'text/x-shellscript; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
