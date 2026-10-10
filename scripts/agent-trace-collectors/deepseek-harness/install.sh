#!/usr/bin/env sh
set -eu

BASE_URL="${AGENT_INSIGHT_BASE_URL:-__AGENT_INSIGHT_BASE_URL__}"
PACKAGE_JSON_URL="$BASE_URL/api/ingest/setup/deepseek-harness/assets/package.json"
INDEX_JS_URL="$BASE_URL/api/ingest/setup/deepseek-harness/assets/index.js"
CORDIS_PATCH_URL="$BASE_URL/api/ingest/setup/deepseek-harness/assets/cordis.patch.yml"
EXPECTED_SOURCE_SHA256="__DEEPSEEK_HARNESS_SOURCE_SHA256__"
EXPECTED_PACKAGE_JSON_SHA256="__DEEPSEEK_HARNESS_PACKAGE_JSON_SHA256__"
EXPECTED_INDEX_JS_SHA256="__DEEPSEEK_HARNESS_INDEX_JS_SHA256__"
EXPECTED_CORDIS_PATCH_SHA256="__DEEPSEEK_HARNESS_CORDIS_PATCH_SHA256__"
DSH_VERSION="0.1.0-rc.8"

fail() {
  printf '%s\n' "DeepSeek Harness observability installation failed: $*" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail "Node.js is required."
command -v npm >/dev/null 2>&1 || fail "npm is required."
command -v curl >/dev/null 2>&1 || fail "curl is required."
[ -n "${AGENT_INSIGHT_API_KEY:-}" ] || fail "Set AGENT_INSIGHT_API_KEY before running this installer."

if ! command -v dsh >/dev/null 2>&1; then
  npm install --global "@deepseek-ai/dsh@$DSH_VERSION" || fail "could not install @deepseek-ai/dsh@$DSH_VERSION."
  NPM_GLOBAL_BIN="$(npm prefix --global)/bin"
  PATH="$NPM_GLOBAL_BIN:$HOME/.npm-global/bin:$PATH"
  export PATH
fi
command -v dsh >/dev/null 2>&1 || fail "dsh is not available on PATH after installation."
command -v pnpm >/dev/null 2>&1 || fail "pnpm is required by 'dsh plugin'; install pnpm and retry."

TMP_ROOT="${TMPDIR:-/tmp}"
STAGE_DIR="$(mktemp -d "$TMP_ROOT/agent-insight-dsh.XXXXXX")"
trap 'rm -rf "$STAGE_DIR"' EXIT HUP INT TERM

PLUGIN_STAGE="$STAGE_DIR/deepseek-harness"
mkdir -p "$PLUGIN_STAGE"

download_plugin_file() {
  name="$1"
  url="$2"
  expected_sha256="$3"
  target="$PLUGIN_STAGE/$name"
  curl -fsSL "$url" -o "$target" || fail "could not download $name."
  actual_sha256="$(node -e 'const c=require("node:crypto");const f=require("node:fs");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$target")"
  [ "$actual_sha256" = "$expected_sha256" ] || fail "$name SHA-256 mismatch."
}

download_plugin_file "package.json" "$PACKAGE_JSON_URL" "$EXPECTED_PACKAGE_JSON_SHA256"
download_plugin_file "index.js" "$INDEX_JS_URL" "$EXPECTED_INDEX_JS_SHA256"
download_plugin_file "cordis.patch.yml" "$CORDIS_PATCH_URL" "$EXPECTED_CORDIS_PATCH_SHA256"

INSTALL_ROOT="$HOME/.agent-insight/deepseek-harness"
VERSION_DIR="$INSTALL_ROOT/$EXPECTED_SOURCE_SHA256"
mkdir -p "$VERSION_DIR"
cp -R "$PLUGIN_STAGE/." "$VERSION_DIR/"

DSH_CONFIG_ROOT="${DSH_HOME:-$HOME/.dsh}"
DSH_ENV_PATH="$DSH_CONFIG_ROOT/.env"
mkdir -p "$DSH_CONFIG_ROOT"
export AGENT_INSIGHT_DSH_ENV_PATH="$DSH_ENV_PATH"
export AGENT_INSIGHT_BASE_URL="$BASE_URL"
node <<'NODE'
const fs = require('node:fs');
const path = process.env.AGENT_INSIGHT_DSH_ENV_PATH;
const updates = new Map([
  ['AGENT_INSIGHT_BASE_URL', process.env.AGENT_INSIGHT_BASE_URL],
  ['AGENT_INSIGHT_API_KEY', process.env.AGENT_INSIGHT_API_KEY],
]);
const existing = fs.existsSync(path) ? fs.readFileSync(path, 'utf8').split(/\r?\n/) : [];
const output = [];
for (const line of existing) {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
  if (match && updates.has(match[1])) continue;
  if (line !== '') output.push(line);
}
for (const [key, value] of updates) output.push(`${key}=${JSON.stringify(value)}`);
fs.writeFileSync(path, `${output.join('\n')}\n`, { mode: 0o600 });
fs.chmodSync(path, 0o600);
NODE

for profile in headless web; do
  dsh plugin --profile "$profile" add "$VERSION_DIR"
  dsh --profile "$profile" --dump-config >/dev/null
done

printf '%s\n' "DeepSeek Harness observability is ready for profiles: headless, web."
printf '%s\n' "Agent Insight endpoint: $BASE_URL/api/ingest/otel/v1/logs"
