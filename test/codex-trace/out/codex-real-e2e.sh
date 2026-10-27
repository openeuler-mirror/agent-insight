#!/usr/bin/env bash
set -euo pipefail

repo=/mnt/d/develop/Trae/AgentInsight/worktrees/codex
server_repo=/root/agent-insight-e2e/codex-v2
evidence=/root/agent-insight-e2e/evidence/issue-159-real-model
client_home="$evidence/${CODEX_CLIENT_HOME_NAME:-client-home}"
codex_home="$client_home/.codex"
server_home="$evidence/server-home"
database="$evidence/agent-insight-real-model.db"
test_user="$evidence/test-user.json"
server_log="$evidence/server.log"
progress_log="$evidence/progress.log"
server_port=3103
relay_port="${CODEX_RELAY_PORT:-43193}"
workspace="$evidence/workspace"
collector="$repo/scripts/agent-trace-collectors/codex"
mcp_fixture="$repo/test/codex-trace/out/codex-mcp-fixture.cjs"
skill_source="$repo/test/codex-trace/out/codex-skill/SKILL.md"
sdk_node_modules="$server_repo/node_modules"

mkdir -p "$evidence" "$client_home" "$codex_home" "$server_home" "$workspace"
chmod 0700 "$evidence" "$client_home" "$codex_home" "$server_home"
install -m 0600 /root/agent-insight-e2e/codex-auth-0145/auth.json "$codex_home/auth.json"

if [[ ! -f "$database" ]]; then
  (
    cd "$server_repo"
    DATABASE_URL="file:$database" ./node_modules/.bin/prisma db push --skip-generate >/dev/null
    DATABASE_URL="file:$database" TEST_USER_PATH="$test_user" node - <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const { PrismaClient } = require("@prisma/client");

(async () => {
  const prisma = new PrismaClient();
  const apiKey = `wi_${crypto.randomBytes(24).toString("hex")}`;
  const username = "codex-chatgpt-openEuler-e2e";
  await prisma.user.create({ data: { username, apiKey } });
  await prisma.$disconnect();
  fs.writeFileSync(
    process.env.TEST_USER_PATH,
    `${JSON.stringify({ username, apiKey })}\n`,
    { mode: 0o600 },
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
NODE
  )
fi

api_key="$(
  node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).apiKey)' \
    "$test_user"
)"

(
  cd "$server_repo"
  exec env \
    HOME="$server_home" \
    DATABASE_URL="file:$database" \
    ./node_modules/.bin/next start -H 127.0.0.1 -p "$server_port" \
    >"$server_log" 2>&1
) &
server_pid=$!

cleanup() {
  kill "$server_pid" 2>/dev/null || true
  wait "$server_pid" 2>/dev/null || true
  unset AGENT_INSIGHT_API_KEY AGENT_INSIGHT_BASE_URL
}
trap cleanup EXIT

for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$server_port/" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    tail -100 "$server_log"
    exit 1
  fi
  sleep 1
done
curl -fsS "http://127.0.0.1:$server_port/" >/dev/null

export HOME="$client_home"
export CODEX_HOME="$codex_home"
export AGENT_INSIGHT_API_KEY="$api_key"
export AGENT_INSIGHT_BASE_URL="http://127.0.0.1:$server_port"

node "$collector/install.cjs" \
  --home "$client_home" \
  --source-dir "$collector" \
  --relay-port "$relay_port" \
  --skip-editor-install \
  >"$evidence/install.log"

mkdir -p "$codex_home/skills/zephyr-checksum"
install -m 0600 "$skill_source" "$codex_home/skills/zephyr-checksum/SKILL.md"

codex mcp remove fixture >/dev/null 2>&1 || true
codex mcp add fixture \
  --env "NODE_PATH=$sdk_node_modules" \
  -- node "$mcp_fixture" \
  >"$evidence/mcp-add.log"

codex login status >"$evidence/login-status.txt" 2>&1
codex mcp list >"$evidence/mcp-list.txt"
node "$client_home/.agent-insight/collectors/codex/self-check.cjs" \
  >"$evidence/self-check.txt"

common=(
  -a never
  exec
  --json
  --skip-git-repo-check
  --sandbox read-only
  --enable multi_agent
  -c 'mcp_servers.fixture.default_tools_approval_mode="approve"'
  --dangerously-bypass-hook-trust
  -C "$workspace"
)

failed=0
selected_cases=",${CODEX_E2E_CASES:-basic,automatic-skill,mcp,subagent},"
run_case() {
  local name="$1"
  local prompt="$2"
  if [[ "$selected_cases" != *",$name,"* ]]; then
    return
  fi
  printf '%s start %s\n' "$(date --iso-8601=seconds)" "$name" >>"$progress_log"
  if codex "${common[@]}" "$prompt" >"$evidence/$name.jsonl" 2>"$evidence/$name.stderr.log"; then
    printf '%s passed %s\n' "$(date --iso-8601=seconds)" "$name" >>"$progress_log"
  else
    printf '%s failed %s\n' "$(date --iso-8601=seconds)" "$name" >>"$progress_log"
    failed=1
  fi
}

run_case basic \
  "Reply with exactly CODEX_COLLECTOR_REAL_MODEL_OK and do not use tools."
run_case automatic-skill \
  "Compute the Zephyr checksum for orbital code A17. Use the applicable installed capability and end with the checksum."
run_case mcp \
  "Use the fixture catalog lookup tool for code K-42, then report the returned catalog value."
run_case subagent \
  "Delegate to one subagent using the agent spawning capability. Ask it to return exactly CHILD_CODEX_OK, wait for it, then report the child result."

node - "$client_home/.agent-insight/collectors/codex/config.json" >"$evidence/flush.json" <<'NODE'
const fs = require("node:fs");
const http = require("node:http");
const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const request = http.request({
  hostname: "127.0.0.1",
  port: config.relayPort,
  path: "/flush",
  method: "POST",
  headers: {
    "content-type": "application/json",
    "content-length": 2,
    "x-agent-insight-relay": config.installSecret,
  },
}, (response) => {
  const chunks = [];
  response.on("data", (chunk) => chunks.push(chunk));
  response.on("end", () => {
    process.stdout.write(Buffer.concat(chunks));
    if (response.statusCode < 200 || response.statusCode >= 300) process.exitCode = 1;
  });
});
request.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
request.end("{}");
NODE

printf '%s complete bypass-run failed=%s\n' "$(date --iso-8601=seconds)" "$failed" >>"$progress_log"
exit "$failed"
