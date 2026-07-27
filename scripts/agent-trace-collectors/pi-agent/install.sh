#!/usr/bin/env sh
set -eu

BASE_URL="${AGENT_INSIGHT_BASE_URL:-__AGENT_INSIGHT_BASE_URL__}"
API_KEY="${AGENT_INSIGHT_API_KEY:-}"
ENDPOINT="${AGENT_INSIGHT_PI_ENDPOINT:-$BASE_URL/api/ingest/otel/v1/traces}"
AGENT_INSIGHT_HOME="${AGENT_INSIGHT_HOME:-$HOME/.agent-insight}"
COLLECTORS_DIR="$AGENT_INSIGHT_HOME/collectors"
PACKAGE_DIR="$COLLECTORS_DIR/pi-agent"
SHARED_DIR="$COLLECTORS_DIR/shared"
ASSET_URL="$BASE_URL/api/ingest/setup/pi-agent/assets"

fail() {
  printf '%s\n' "Pi Agent collector installation failed: $*" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail "Node.js is required (>=22.19.0)."
command -v curl >/dev/null 2>&1 || fail "curl is required."
command -v pi >/dev/null 2>&1 || fail "Pi CLI is required. Install @earendil-works/pi-coding-agent 0.82.x first."
[ -n "$API_KEY" ] || fail "Set AGENT_INSIGHT_API_KEY before running this installer."

node -e '
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 19)) process.exit(1);
' || fail "Node.js $(node --version) is unsupported; Pi requires >=22.19.0."

PI_VERSION="$(pi --version 2>/dev/null | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1 || true)"
case "$PI_VERSION" in
  0.82.*) ;;
  *) fail "Pi CLI $PI_VERSION is unsupported; expected 0.82.x." ;;
esac

TMP_ROOT="${TMPDIR:-/tmp}"
STAGE_DIR="$(mktemp -d "$TMP_ROOT/agent-insight-pi.XXXXXX")"
trap 'rm -rf "$STAGE_DIR"' EXIT HUP INT TERM

mkdir -p "$STAGE_DIR/pi-agent/extensions" "$STAGE_DIR/pi-agent/lib" "$STAGE_DIR/pi-agent/scripts" "$STAGE_DIR/shared"
curl -fsSL "$ASSET_URL/package.json" -o "$STAGE_DIR/pi-agent/package.json"
curl -fsSL "$ASSET_URL/pi-agent-insight.ts" -o "$STAGE_DIR/pi-agent/extensions/pi-agent-insight.ts"
curl -fsSL "$ASSET_URL/pi-trace-core.cjs" -o "$STAGE_DIR/pi-agent/lib/pi-trace-core.cjs"
curl -fsSL "$ASSET_URL/self-check.cjs" -o "$STAGE_DIR/pi-agent/scripts/self-check.cjs"
curl -fsSL "$ASSET_URL/uninstall.cjs" -o "$STAGE_DIR/pi-agent/scripts/uninstall.cjs"
curl -fsSL "$ASSET_URL/trace-transport.cjs" -o "$STAGE_DIR/shared/trace-transport.cjs"

mkdir -p "$PACKAGE_DIR/extensions" "$PACKAGE_DIR/lib" "$PACKAGE_DIR/scripts" "$SHARED_DIR"
install -m 0644 "$STAGE_DIR/pi-agent/package.json" "$PACKAGE_DIR/package.json"
install -m 0644 "$STAGE_DIR/pi-agent/extensions/pi-agent-insight.ts" "$PACKAGE_DIR/extensions/pi-agent-insight.ts"
install -m 0644 "$STAGE_DIR/pi-agent/lib/pi-trace-core.cjs" "$PACKAGE_DIR/lib/pi-trace-core.cjs"
install -m 0755 "$STAGE_DIR/pi-agent/scripts/self-check.cjs" "$PACKAGE_DIR/scripts/self-check.cjs"
install -m 0755 "$STAGE_DIR/pi-agent/scripts/uninstall.cjs" "$PACKAGE_DIR/scripts/uninstall.cjs"
install -m 0644 "$STAGE_DIR/shared/trace-transport.cjs" "$SHARED_DIR/trace-transport.cjs"

export PI_COLLECTOR_CONFIG="$PACKAGE_DIR/config.json"
export PI_COLLECTOR_ENDPOINT="$ENDPOINT"
node - <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const target = process.env.PI_COLLECTOR_CONFIG;
const temp = `${target}.${process.pid}.tmp`;
const config = {
  version: 1,
  enabled: true,
  apiKey: process.env.AGENT_INSIGHT_API_KEY,
  endpoint: process.env.PI_COLLECTOR_ENDPOINT,
  uploadIntervalMs: 300000,
  shutdownTimeoutMs: 2200
};
fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
fs.writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temp, target);
fs.chmodSync(target, 0o600);
NODE

pi remove "$PACKAGE_DIR" >/dev/null 2>&1 || true
pi install "$PACKAGE_DIR"
node "$PACKAGE_DIR/scripts/self-check.cjs"

printf '%s\n' "Pi Agent collector installed at $PACKAGE_DIR"
printf '%s\n' "Spool data is isolated under $AGENT_INSIGHT_HOME/otel_data/pi-agent/<api-key-hash>/"
