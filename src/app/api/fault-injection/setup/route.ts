import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

/**
 * curl -fsSL "$HOST/api/fault-injection/setup?key=$API_KEY" | bash
 */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const key = url.searchParams.get('key') || ''
  const base = `${url.protocol}//${url.host}`
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
if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required" >&2
  exit 1
fi
export AGENT_INSIGHT_HOST="\$HOST"
export AGENT_INSIGHT_API_KEY="\$KEY"
npx --yes agent-insight install-fault-injection --start || {
  echo "npx install failed; if you have a local clone, run:"
  echo "  AGENT_INSIGHT_HOST=\$HOST AGENT_INSIGHT_API_KEY=\$KEY node scripts/install-fault-injection.js --start"
  exit 1
}
echo "==> Setup finished. Worker runs in the background; you can close this terminal."
echo "    If a Worker was previously started with another API key, this run restarts it with the new key."
echo "    Refresh /agent-ras/fault-injection/tasks/new to confirm Worker is online."
`

  return new NextResponse(script, {
    status: 200,
    headers: {
      'Content-Type': 'text/x-shellscript; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}
