#!/usr/bin/env sh
set -eu

BASE_URL="${AGENT_INSIGHT_BASE_URL:-__AGENT_INSIGHT_BASE_URL__}"
ASSET_URL="$BASE_URL/api/ingest/setup/codex/assets"

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
  echo "curl is required to download the first-party collector assets." >&2
  exit 1
fi

STAGING_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGING_DIR"' EXIT HUP INT TERM
mkdir -p "$STAGING_DIR/codex/vscode-extension" "$STAGING_DIR/shared"

download() {
  asset="$1"
  target="$2"
  curl --fail --silent --show-error "$ASSET_URL/$asset" --output "$target"
}

download "trace-transport.cjs" "$STAGING_DIR/shared/trace-transport.cjs"
download "codex-trace-core.cjs" "$STAGING_DIR/codex/codex-trace-core.cjs"
download "config-core.cjs" "$STAGING_DIR/codex/config-core.cjs"
download "hook-handler.cjs" "$STAGING_DIR/codex/hook-handler.cjs"
download "relay.cjs" "$STAGING_DIR/codex/relay.cjs"
download "install.cjs" "$STAGING_DIR/codex/install.cjs"
download "uninstall.cjs" "$STAGING_DIR/codex/uninstall.cjs"
download "self-check.cjs" "$STAGING_DIR/codex/self-check.cjs"
download "build-vsix.cjs" "$STAGING_DIR/codex/build-vsix.cjs"
download "extension-package.json" "$STAGING_DIR/codex/vscode-extension/package.json"
download "extension.cjs" "$STAGING_DIR/codex/vscode-extension/extension.cjs"
download "ide-trace-core.cjs" "$STAGING_DIR/codex/vscode-extension/ide-trace-core.cjs"
download "extension.vsixmanifest" "$STAGING_DIR/codex/vscode-extension/extension.vsixmanifest"
download "Content_Types.xml" "$STAGING_DIR/codex/vscode-extension/[Content_Types].xml"

node "$STAGING_DIR/codex/install.cjs" --source-dir "$STAGING_DIR/codex" "$@"
