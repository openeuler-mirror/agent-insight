#!/usr/bin/env sh
set -eu

BASE_URL="${AGENT_INSIGHT_BASE_URL:-__AGENT_INSIGHT_BASE_URL__}"
BUNDLE_URL="$BASE_URL/api/ingest/setup/pi-agent/assets/pi-agent-bundle.zip"
EXPECTED_BUNDLE_SHA256="__PI_AGENT_BUNDLE_SHA256__"

fail() {
  printf '%s\n' "Pi Agent collector installation failed: $*" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail "Node.js is required (>=22.19.0)."
command -v curl >/dev/null 2>&1 || fail "curl is required."
command -v unzip >/dev/null 2>&1 || fail "unzip is required."
[ -n "${AGENT_INSIGHT_API_KEY:-}" ] || fail "Set AGENT_INSIGHT_API_KEY before running this installer."

TMP_ROOT="${TMPDIR:-/tmp}"
STAGE_DIR="$(mktemp -d "$TMP_ROOT/agent-insight-pi.XXXXXX")"
trap 'rm -rf "$STAGE_DIR"' EXIT HUP INT TERM

BUNDLE_PATH="$STAGE_DIR/pi-agent-bundle.zip"
curl -fsSL "$BUNDLE_URL" -o "$BUNDLE_PATH"
ACTUAL_BUNDLE_SHA256="$(node -e 'const c=require("node:crypto");const f=require("node:fs");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$BUNDLE_PATH")"
[ "$ACTUAL_BUNDLE_SHA256" = "$EXPECTED_BUNDLE_SHA256" ] || fail "collector bundle SHA-256 mismatch."
unzip -q "$BUNDLE_PATH" -d "$STAGE_DIR"
[ -f "$STAGE_DIR/pi-agent/install.cjs" ] || fail "collector bundle is incomplete."

export AGENT_INSIGHT_BASE_URL="$BASE_URL"
node "$STAGE_DIR/pi-agent/install.cjs" --source-dir "$STAGE_DIR/pi-agent" "$@"
