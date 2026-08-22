#!/usr/bin/env sh
set -eu

BASE_URL="${AGENT_INSIGHT_BASE_URL:-__AGENT_INSIGHT_BASE_URL__}"
BUNDLE_URL="$BASE_URL/api/ingest/setup/codex/assets/codex-collector-bundle.zip"
EXPECTED_BUNDLE_SHA256="__CODEX_COLLECTOR_BUNDLE_SHA256__"

if [ -z "${AGENT_INSIGHT_API_KEY:-}" ]; then
  echo "AGENT_INSIGHT_API_KEY is required." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js >=20 is required." >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node.js >=20 is required; found $(node --version)." >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required to download the first-party collector bundle." >&2
  exit 1
fi

if ! command -v unzip >/dev/null 2>&1; then
  echo "unzip is required to extract the first-party collector bundle." >&2
  exit 1
fi

STAGING_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGING_DIR"' EXIT HUP INT TERM
BUNDLE_PATH="$STAGING_DIR/codex-collector-bundle.zip"
curl --fail --silent --show-error "$BUNDLE_URL" --output "$BUNDLE_PATH"
ACTUAL_BUNDLE_SHA256="$(node -e 'const c=require("node:crypto");const f=require("node:fs");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$BUNDLE_PATH")"
if [ "$ACTUAL_BUNDLE_SHA256" != "$EXPECTED_BUNDLE_SHA256" ]; then
  echo "Codex collector bundle SHA-256 mismatch." >&2
  exit 1
fi
unzip -q "$BUNDLE_PATH" -d "$STAGING_DIR"
if [ ! -f "$STAGING_DIR/codex/install.cjs" ]; then
  echo "Codex collector bundle is incomplete." >&2
  exit 1
fi

node "$STAGING_DIR/codex/install.cjs" --source-dir "$STAGING_DIR/codex" "$@"
