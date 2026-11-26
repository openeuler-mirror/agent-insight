#!/bin/bash
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


# Enable verbose mode to see what's happening
# set -x

# Navigate to the project root directory
cd "$(dirname "$0")/.."

if [ "${AGENT_INSIGHT_RUNTIME_CHILD:-}" != "1" ]; then
  exec node scripts/project-storage.cjs dev "$@"
fi

PORT="${AGENT_INSIGHT_PORT:-3000}"
if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  echo "Error: AGENT_INSIGHT_PORT must be an integer between 1 and 65535." >&2
  exit 1
fi

PROCESS_DATABASE_URL_IS_SET="${DATABASE_URL+x}"
PROCESS_DATABASE_URL="${DATABASE_URL:-}"

if [ -n "${AGENT_INSIGHT_DATA_DIR:-}" ]; then
  echo "Error: AGENT_INSIGHT_DATA_DIR is no longer supported; rename it to AGENT_INSIGHT_HOME and unset AGENT_INSIGHT_DATA_DIR (keep the same root path)." >&2
  exit 1
fi
AGENT_INSIGHT_HOME="${AGENT_INSIGHT_HOME:-$HOME/.agent-insight}"
case "$AGENT_INSIGHT_HOME" in
  '~'|'$HOME'|'${HOME}') AGENT_INSIGHT_HOME="$HOME" ;;
  '~/'*) AGENT_INSIGHT_HOME="$HOME/${AGENT_INSIGHT_HOME#\~/}" ;;
  '$HOME/'*) AGENT_INSIGHT_HOME="$HOME/${AGENT_INSIGHT_HOME#\$HOME/}" ;;
  '${HOME}/'*) AGENT_INSIGHT_HOME="$HOME/${AGENT_INSIGHT_HOME#\$\{HOME\}/}" ;;
esac
case "$AGENT_INSIGHT_HOME" in /*) ;; *) AGENT_INSIGHT_HOME="$PWD/$AGENT_INSIGHT_HOME" ;; esac
RESOLVED_AGENT_INSIGHT_HOME="$AGENT_INSIGHT_HOME"
AGENT_INSIGHT_ENV_FILE="$AGENT_INSIGHT_HOME/.env"
AGENT_INSIGHT_STORAGE_DIR="$AGENT_INSIGHT_HOME/data"

load_agent_insight_env() {
  local runtime_core_url="${AGENT_INSIGHT_STORAGE_CORE_URL:-}"
  local runtime_controller="${AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE:-}"

  if [ -f "$AGENT_INSIGHT_ENV_FILE" ]; then
    set -a
    source "$AGENT_INSIGHT_ENV_FILE"
    set +a
  fi

  AGENT_INSIGHT_HOME="$RESOLVED_AGENT_INSIGHT_HOME"
  AGENT_INSIGHT_STORAGE_DIR="$AGENT_INSIGHT_HOME/data"
  export AGENT_INSIGHT_HOME
  export AGENT_INSIGHT_STORAGE_DIR
  export AGENT_INSIGHT_PORT="$PORT"
if [ -n "${AGENT_INSIGHT_DATA_DIR:-}" ]; then
  echo "Error: AGENT_INSIGHT_DATA_DIR is no longer supported; rename it to AGENT_INSIGHT_HOME and unset AGENT_INSIGHT_DATA_DIR (keep the same root path)." >&2
  exit 1
fi
  [ "$PROCESS_DATABASE_URL_IS_SET" != x ] || export DATABASE_URL="$PROCESS_DATABASE_URL"
  export AGENT_INSIGHT_STORAGE_CORE_URL="$runtime_core_url"
  export AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE="$runtime_controller"


}

ensure_goal_plus_watcher() {
  local collector_source="$(pwd)/scripts/agent-trace-collectors/goal-plus/goal-plus-collector.cjs"
  local collector_config="$AGENT_INSIGHT_HOME/collectors/goal-plus/config.json"
  local interval_ms="${AGENT_INSIGHT_GOAL_PLUS_INTERVAL_MS:-5000}"
  local result=""

  if [ ! -f "$collector_config" ]; then
    return 0
  fi
  if [ ! -f "$collector_source" ]; then
    echo "⚠️  Goal Plus watcher was not checked: collector source is missing at $collector_source"
    return 0
  fi

  echo "Ensuring Goal Plus watcher is running..."
  if result=$(node "$collector_source" ensure --config "$collector_config" --interval-ms "$interval_ms" 2>&1); then
    echo "$result"
  else
    echo "⚠️  Goal Plus watcher could not be started; Agent Insight remains available."
    echo "$result"
  fi
}

# Auto-initialize unified environment and data directory
if [ ! -f "$AGENT_INSIGHT_ENV_FILE" ] && [ -f .env.example ]; then
  echo "No ~/.agent-insight/.env found. Initializing from .env.example..."
  mkdir -p "$AGENT_INSIGHT_HOME"
  # 生成时在文件头注明：这是当前生效的配置，由模板自动生成，改这里而不是改 .env.example
  {
    echo "# >>> 本文件由 scripts/develop_start.sh 于 $(date '+%Y-%m-%d %H:%M:%S') 从 .env.example 自动生成 <<<"
    echo "# 这是 agent-insight 当前生效的环境配置；要改配置请直接编辑本文件。"
    echo "# 项目根目录的 .env.example 只是模板，改它不会影响已生成的本文件。"
    echo "# 注意：启动会同步 AGENT_INSIGHT_HOST；AGENT_INSIGHT_API_KEY 仅在缺失时初始化，安装指导注册的用户 Key 会保留。"
    echo "#"
    cat .env.example
  } > "$AGENT_INSIGHT_ENV_FILE"
  chmod 600 "$AGENT_INSIGHT_ENV_FILE" 2>/dev/null || true
fi

if [ ! -d "$AGENT_INSIGHT_STORAGE_DIR" ]; then
  echo "Creating data directory at $AGENT_INSIGHT_STORAGE_DIR..."
  mkdir -p "$AGENT_INSIGHT_STORAGE_DIR"
fi

echo "=== Restart Script (DEV MODE) Started ==="

# Function to find PID using various tools
find_pid_on_port() {
  local port=$1
  local pid=""
  
  if command -v lsof >/dev/null 2>&1; then
    pid=$(lsof -t -i:${port} -sTCP:LISTEN)
  fi
  
  if [ -z "$pid" ] && command -v netstat >/dev/null 2>&1; then
    # Parse netstat output for PIDs
    pid=$(netstat -nlp 2>/dev/null | grep ":$port " | awk '{print $7}' | cut -d'/' -f1)
  fi
  
  if [ -z "$pid" ] && command -v ss >/dev/null 2>&1; then
    pid=$(ss -lptn "sport = :$port" 2>/dev/null | grep -oP 'pid=\K\d+')
  fi
  
  # Return the PID(s)
  echo "$pid"
}

echo "Checking port $PORT..."

# Load the Web configuration before checking both storage dependencies.
load_agent_insight_env
if [ "${AGENT_INSIGHT_RUNTIME_CHILD:-}" != "1" ]; then
  exec node scripts/local-runtime.cjs start dev "$@"
fi

node scripts/storage-core-preflight.cjs || exit 1

echo "Storage: Core transactional backend + ClickHouse"

# 4. Start in DEV mode
echo "-----------------------------------"
echo "Reusing Next.js development cache..."

echo "Generating Prisma client..."
if ! npx prisma generate; then
  echo ""
  echo "  ⛔ prisma generate 失败 —— 兼容类型生成失败。"
  echo "     请修复生成步骤后重试；此步骤不连接业务数据库。"
  echo "     常见原因：node_modules 里有 root 拥有的文件（之前用 sudo npm install 过）。"
  echo "     修法："
  echo "       sudo chown -R \"\$(whoami)\":staff node_modules/.prisma node_modules/@prisma"
  echo "       bash scripts/develop_start.sh"
  echo "     退出脚本。"
  exit 1
fi

echo "Starting server in DEVELOPMENT mode (npm run dev)..."

set -a
load_agent_insight_env
set +a

node scripts/benchmark/generate-catalog.cjs || exit 1
NEW_PID=$(node scripts/local-runtime.cjs launch-web dev "$PORT") || exit 1
LOG_FILE="$AGENT_INSIGHT_HOME/logs/web.log"

echo "Server process started."
echo "PID: $NEW_PID"
echo "Log file: $LOG_FILE"
echo "Waiting for the API to become ready and syncing the admin API key..."
STARTUP_TIMEOUT_SECONDS="${AGENT_INSIGHT_STARTUP_TIMEOUT_SECONDS:-600}"
STARTUP_DEADLINE=$((SECONDS + STARTUP_TIMEOUT_SECONDS))
SERVER_READY=false
while [ "$SECONDS" -lt "$STARTUP_DEADLINE" ]; do
  if ! kill -0 "$NEW_PID" 2>/dev/null; then
    echo "⛔ Server process exited before becoming ready. Check $LOG_FILE."
    tail -n 40 "$LOG_FILE" 2>/dev/null || true
    exit 1
  fi
  if curl --noproxy '*' -fsS --max-time 3 -o /dev/null "http://127.0.0.1:$PORT${NEXT_PUBLIC_URL_PREFIX:-}/login" 2>/dev/null \
    && node scripts/sync_admin_api_key.js "$PORT" "http://localhost:$PORT" 2>/dev/null; then
    SERVER_READY=true
    break
  fi
  sleep 2
done

if [ "$SERVER_READY" != "true" ]; then
  echo "⛔ Server API did not become ready within ${STARTUP_TIMEOUT_SECONDS}s."
  echo "   Check $LOG_FILE, then rerun bash scripts/develop_start.sh."
  tail -n 40 "$LOG_FILE" 2>/dev/null || true
  exit 1
fi

echo "Server is ready."
ensure_goal_plus_watcher
echo "-----------------------------------"
