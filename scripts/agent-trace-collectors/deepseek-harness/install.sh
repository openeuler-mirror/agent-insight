#!/usr/bin/env sh
# Copyright (c) 2026 Huawei Technologies Co., Ltd.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

set -eu

BASE_URL="${AGENT_INSIGHT_BASE_URL:-__AGENT_INSIGHT_BASE_URL__}"
PACKAGE_JSON_URL="$BASE_URL/api/ingest/setup/deepseek-harness/assets/package.json"
INDEX_JS_URL="$BASE_URL/api/ingest/setup/deepseek-harness/assets/index.js"
CORDIS_PATCH_URL="$BASE_URL/api/ingest/setup/deepseek-harness/assets/cordis.patch.yml"
EXPECTED_SOURCE_SHA256="__DEEPSEEK_HARNESS_SOURCE_SHA256__"
EXPECTED_PACKAGE_JSON_SHA256="__DEEPSEEK_HARNESS_PACKAGE_JSON_SHA256__"
EXPECTED_INDEX_JS_SHA256="__DEEPSEEK_HARNESS_INDEX_JS_SHA256__"
EXPECTED_CORDIS_PATCH_SHA256="__DEEPSEEK_HARNESS_CORDIS_PATCH_SHA256__"
DSH_VERSION="0.2.2-rc.1"

fail() {
  printf '%s\n' "DeepSeek Harness observability installation failed: $*" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail "Node.js is required."
command -v npm >/dev/null 2>&1 || fail "npm is required."
command -v curl >/dev/null 2>&1 || fail "curl is required."
[ -n "${AGENT_INSIGHT_API_KEY:-}" ] || fail "Set AGENT_INSIGHT_API_KEY before running this installer."

require_modern_node() {
  node --input-type=module -e 'import { registerHooks } from "node:module"; const [major,minor]=process.versions.node.split(".").map(Number); if (typeof registerHooks !== "function" || major < 24 || (major === 24 && minor < 9)) process.exit(1)' || fail "Harness 0.2.2-rc.1 requires an independent Node.js 24.9+ runtime; existing Node.js configuration was not changed."
}

if ! command -v dsh >/dev/null 2>&1; then
  require_modern_node
  npm install --global "@deepseek-ai/dsh@$DSH_VERSION" || fail "could not install @deepseek-ai/dsh@$DSH_VERSION."
  NPM_GLOBAL_BIN="$(npm prefix --global)/bin"
  PATH="$NPM_GLOBAL_BIN:$HOME/.npm-global/bin:$PATH"
  export PATH
fi
command -v dsh >/dev/null 2>&1 || fail "dsh is not available on PATH after installation."
DETECTED_DSH_VERSION="$(dsh --version)"
case "$DETECTED_DSH_VERSION" in
  0.1.0-rc.8) export AGENT_INSIGHT_DSH_LIVE=0 ;;
  0.2.2-rc.1) require_modern_node; export AGENT_INSIGHT_DSH_LIVE=1 ;;
  *) fail "unsupported Harness version $DETECTED_DSH_VERSION; existing configuration was not changed." ;;
esac
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
download_plugin_file "dsh-context-source.mjs" "$BASE_URL/api/ingest/setup/deepseek-harness/assets/dsh-context-source.mjs" "__DEEPSEEK_HARNESS_CONTEXT_SOURCE_SHA256__"
download_plugin_file "dsh-context-details.mjs" "$BASE_URL/api/ingest/setup/deepseek-harness/assets/dsh-context-details.mjs" "__DEEPSEEK_HARNESS_CONTEXT_DETAILS_SHA256__"
download_plugin_file "process-lock.mjs" "$BASE_URL/api/ingest/setup/deepseek-harness/assets/process-lock.mjs" "__DEEPSEEK_HARNESS_PROCESS_LOCK_SHA256__"
download_plugin_file "replay-compat.mjs" "$BASE_URL/api/ingest/setup/deepseek-harness/assets/replay-compat.mjs" "__DEEPSEEK_HARNESS_REPLAY_COMPAT_SHA256__"

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
  ['AGENT_INSIGHT_DSH_LIVE', process.env.AGENT_INSIGHT_DSH_LIVE],
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

mkdir -p "$HOME/.local/bin"
export AGENT_INSIGHT_DSH_NATIVE="$(command -v dsh)" AGENT_INSIGHT_DSH_PLUGIN_DIR="$VERSION_DIR"
node <<'NODE'
const fs = require('node:fs');
const q = value => "'" + value.replaceAll("'", "'\\''") + "'";
const args = process.env.AGENT_INSIGHT_DSH_LIVE === '1'
  ? q(process.execPath) + ' --import ' + q(process.env.AGENT_INSIGHT_DSH_PLUGIN_DIR + '/replay-compat.mjs') + ' ' + q(process.env.AGENT_INSIGHT_DSH_NATIVE)
  : q(process.env.AGENT_INSIGHT_DSH_NATIVE);
fs.writeFileSync(process.env.HOME + '/.local/bin/dsh-agent-insight', '#!/bin/sh\nexec ' + args + ' "$@"\n', { mode: 0o700 });
NODE

printf '%s\n' "DeepSeek Harness observability is ready for profiles: headless, web."
printf '%s\n' "Agent Insight endpoint: $BASE_URL/api/ingest/otel/v1/logs"
printf '%s\n' "Use $HOME/.local/bin/dsh-agent-insight for version-checked replay compatibility; native package files remain unchanged."

printf '%s\n' "Context source: reuse installed dsh-context 0.85.1 facts/delta when available; unsupported or missing plugins keep core Trace and boundary captures."
