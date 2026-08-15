#!/usr/bin/env sh
set -eu

BASE_URL="${AGENT_INSIGHT_BASE_URL:-__AGENT_INSIGHT_BASE_URL__}"
ASSET_URL="$BASE_URL/api/ingest/setup/pi-agent/assets"

fail() {
  printf '%s\n' "Pi Agent collector installation failed: $*" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail "Node.js is required (>=22.19.0)."
command -v curl >/dev/null 2>&1 || fail "curl is required."
[ -n "${AGENT_INSIGHT_API_KEY:-}" ] || fail "Set AGENT_INSIGHT_API_KEY before running this installer."

TMP_ROOT="${TMPDIR:-/tmp}"
STAGE_DIR="$(mktemp -d "$TMP_ROOT/agent-insight-pi.XXXXXX")"
trap 'rm -rf "$STAGE_DIR"' EXIT HUP INT TERM

mkdir -p "$STAGE_DIR/pi-agent/extensions" "$STAGE_DIR/pi-agent/lib" "$STAGE_DIR/pi-agent/scripts" "$STAGE_DIR/shared"
curl -fsSL "$ASSET_URL/package.json" -o "$STAGE_DIR/pi-agent/package.json"
curl -fsSL "$ASSET_URL/pi-agent-insight.ts" -o "$STAGE_DIR/pi-agent/extensions/pi-agent-insight.ts"
curl -fsSL "$ASSET_URL/pi-trace-core.cjs" -o "$STAGE_DIR/pi-agent/lib/pi-trace-core.cjs"
curl -fsSL "$ASSET_URL/self-check.cjs" -o "$STAGE_DIR/pi-agent/scripts/self-check.cjs"
curl -fsSL "$ASSET_URL/uninstall.cjs" -o "$STAGE_DIR/pi-agent/scripts/uninstall.cjs"
curl -fsSL "$ASSET_URL/install.cjs" -o "$STAGE_DIR/pi-agent/install.cjs"
curl -fsSL "$ASSET_URL/trace-transport.cjs" -o "$STAGE_DIR/shared/trace-transport.cjs"

export AGENT_INSIGHT_BASE_URL="$BASE_URL"
node "$STAGE_DIR/pi-agent/install.cjs" --source-dir "$STAGE_DIR/pi-agent" "$@"
