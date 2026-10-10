import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

/**
 * curl -fsSL "$HOST/api/fault-injection/setup?key=$API_KEY" | bash
 */
function normalizeClientBaseUrl(reqUrl: URL): string {
  const base = new URL(`${reqUrl.protocol}//${reqUrl.host}`)
  if (base.hostname === '0.0.0.0' || base.hostname === '::' || base.hostname === '[::]') {
    base.hostname = '127.0.0.1'
  }
  return base.origin
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const key = url.searchParams.get('key') || ''
  const base = normalizeClientBaseUrl(url)
  if (!key) {
    return new NextResponse('Missing key query param\n', { status: 400 })
  }

  const script = `#!/usr/bin/env bash
set -euo pipefail
HOST=${JSON.stringify(base)}
KEY=${JSON.stringify(key)}
echo "==> Agent Insight FI Worker setup"
echo "    host=\$HOST"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required" >&2
  exit 1
fi
export AGENT_INSIGHT_HOST="\$HOST"
export AGENT_INSIGHT_API_KEY="\$KEY"

# Prefer a local clone when the shell cwd is the repo (common while developing).
# Otherwise run npx from an empty temp dir: if cwd is inside this package (esp. on
# WSL /mnt/*), npx resolves agent-insight via file: and can fail with ECOMPROMISED.
if [ -f "./scripts/install-fault-injection.js" ] && [ -d "./agent_fault_injection" ]; then
  echo "    using local clone installer"
  node "./scripts/install-fault-injection.js" --start
else
  fi_tmp=\$(mktemp -d "\${TMPDIR:-/tmp}/agent-insight-fi.XXXXXX")
  cleanup_fi_tmp() { rm -rf -- "\$fi_tmp"; }
  trap cleanup_fi_tmp EXIT
  if ! (cd "\$fi_tmp" && npx --yes agent-insight install-fault-injection --start); then
    echo "npx install failed" >&2
    exit 1
  fi
  trap - EXIT
  cleanup_fi_tmp
fi

echo "==> Setup finished. Worker runs in the background; you can close this terminal."
echo "    If a Worker was previously started with another API key, this run restarts it with the new key."
echo "    Refresh /experiments/new (reliability dataset) or Worker health to confirm Worker is online."
`

  return new NextResponse(script, {
    status: 200,
    headers: {
      'Content-Type': 'text/x-shellscript; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}
