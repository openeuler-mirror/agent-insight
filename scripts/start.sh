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
cd "$(dirname "$0")/.." || exit 1

if [ "${AGENT_INSIGHT_RUNTIME_CHILD:-}" != "1" ] && [ "${1:-}" != "--help" ] && [ "${1:-}" != "-h" ]; then
  exec node scripts/project-storage.cjs production "$@"
fi
clock_ms() {
  if [ -n "${EPOCHREALTIME:-}" ]; then
    local now="${EPOCHREALTIME/./}"
    echo "$((10#$now / 1000))"
  else
    echo "$((SECONDS * 1000))"
  fi
}
START_MILLISECONDS=$(clock_ms)

RUNTIME_START_ARGS=("$@")
START_PORT=""
FORCE_REBUILD=""

start_usage() {
  cat <<'EOF'
Usage: [AGENT_INSIGHT_PORT=3000] bash scripts/start.sh [--port PORT] [--force-rebuild]

Reads config/storage.local.json and starts Core + Web against user-managed databases.
Run scripts/install.sh for first-time initialization.
Reuses a verified unchanged build; otherwise rebuilds with cache preserved.
--force-rebuild always rebuilds, keeping the incremental cache.
SWE-bench Verified is prepared automatically with its official loader unless
already installed. ZSoft L1 is also prepared automatically unless installed.
Each benchmark can opt out via dataset.autoImport in config/benchmark/platform.local.yaml.
Preparation failures warn and do not prevent startup.
EOF
}

start_fail() {
  echo "启动参数错误：$1" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --force-rebuild)
      FORCE_REBUILD="--force-rebuild"
      shift
      ;;
    --port)
      [ "$#" -ge 2 ] || start_fail '--port 缺少参数值'
      [ -z "$START_PORT" ] || start_fail '--port 只能指定一次'
      [ -n "$2" ] || start_fail '--port 缺少参数值'
      START_PORT="$2"
      shift 2
      ;;
    --help|-h)
      start_usage
      exit 0
      ;;
    *) start_fail "不支持的参数：$1" ;;
  esac
done

if [ -n "${PORT:-}" ]; then
  start_fail 'PORT 已移除，请改用 AGENT_INSIGHT_PORT 并移除旧 PORT 配置'
fi

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

  local name
  local overrides=()
  # 保留启动环境的显式空值，使其也能覆盖 .env。
  for name in AGENT_INSIGHT_PORT DATABASE_URL AGENT_INSIGHT_CONFIG_DIR; do
    if [ "${!name+x}" = x ]; then
      overrides+=("$name=${!name}")
    fi
  done

  if [ -f "$AGENT_INSIGHT_ENV_FILE" ]; then
    set -a
    . "$AGENT_INSIGHT_ENV_FILE"
    set +a
  fi

  AGENT_INSIGHT_HOME="$RESOLVED_AGENT_INSIGHT_HOME"
  AGENT_INSIGHT_STORAGE_DIR="$AGENT_INSIGHT_HOME/data"
  export AGENT_INSIGHT_HOME
  export AGENT_INSIGHT_STORAGE_DIR
  export AGENT_INSIGHT_STORAGE_CORE_URL="$runtime_core_url"
  export AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE="$runtime_controller"
  if [ -n "${AGENT_INSIGHT_DATA_DIR:-}" ]; then
    echo "Error: AGENT_INSIGHT_DATA_DIR is no longer supported; rename it to AGENT_INSIGHT_HOME and unset AGENT_INSIGHT_DATA_DIR (keep the same root path)." >&2
    exit 1
  fi

  if [ "${#overrides[@]}" -gt 0 ]; then
    export "${overrides[@]}"
  fi


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
    echo "# >>> 本文件由 scripts/start.sh 于 $(date '+%Y-%m-%d %H:%M:%S') 从 .env.example 自动生成 <<<"
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

echo "=== Start Script Started ==="

# Function to find PID using various tools
find_pid_on_port() {
  local port=$1
  local pid=""
  
  if command -v lsof >/dev/null 2>&1; then
    # Only match LISTEN sockets — otherwise outbound connections to a remote
    # :$port (e.g. a browser tab) get reported as "occupying" the local port.
    pid=$(lsof -t -iTCP:$port -sTCP:LISTEN 2>/dev/null)
  fi

  if [ -z "$pid" ] && command -v netstat >/dev/null 2>&1; then
    # `-l` already restricts to listeners on Linux netstat.
    pid=$(netstat -nlp 2>/dev/null | grep ":$port " | awk '{print $7}' | cut -d'/' -f1)
  fi

  if [ -z "$pid" ] && command -v ss >/dev/null 2>&1; then
    pid=$(ss -lptn "sport = :$port" 2>/dev/null | grep -oP 'pid=\K\d+')
  fi
  
  # Return the PID(s)
  echo "$pid"
}

# Load the Web configuration before checking both storage dependencies.
load_agent_insight_env

if [ -n "${PORT:-}" ]; then
  start_fail 'PORT 已移除，请改用 AGENT_INSIGHT_PORT 并移除旧 PORT 配置'
fi
PLATFORM_PORT="${START_PORT:-${AGENT_INSIGHT_PORT:-3000}}"
case "$PLATFORM_PORT" in
  *[!0-9]*|'') start_fail "AGENT_INSIGHT_PORT / --port 必须是 1 到 65535 的整数：$PLATFORM_PORT" ;;
esac
if [ "${#PLATFORM_PORT}" -gt 5 ] || [ "$PLATFORM_PORT" -lt 1 ] || [ "$PLATFORM_PORT" -gt 65535 ]; then
  start_fail "AGENT_INSIGHT_PORT / --port 必须是 1 到 65535 的整数：$PLATFORM_PORT"
fi
echo "Checking port $PLATFORM_PORT..."

if [ "${AGENT_INSIGHT_RUNTIME_CHILD:-}" != "1" ]; then
  exec node scripts/local-runtime.cjs start production "${RUNTIME_START_ARGS[@]}"
fi

echo "Storage: Core transactional backend + ClickHouse"

STAGE_MILLISECONDS=$START_MILLISECONDS
CURRENT_STAGE="configuration"
print_elapsed() {
  local elapsed=$(($(clock_ms) - $2))
  printf '[timing] %s: %d.%03ds%s\n' "$1" "$((elapsed / 1000))" "$((elapsed % 1000))" "${3:-}"
}
stage_done() {
  print_elapsed "$CURRENT_STAGE" "$STAGE_MILLISECONDS"
}
stage_begin() {
  CURRENT_STAGE="$1"
  STAGE_MILLISECONDS=$(clock_ms)
  echo "[stage] $CURRENT_STAGE"
}
finish_timing() {
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    print_elapsed "$CURRENT_STAGE failed" "$STAGE_MILLISECONDS" >&2
  fi
  print_elapsed "total" "$START_MILLISECONDS" " (exit=$rc)"
}
trap finish_timing EXIT
stage_done

stage_begin "startup lock"
mkdir -p .next/cache/agent-insight || exit 1
if command -v flock >/dev/null 2>&1; then
  exec 9>.next/cache/agent-insight/start.lock
  if ! flock -n 9; then
    echo "Another start.sh is running in this directory; retry after it finishes." >&2
    exit 1
  fi
fi
stage_done

stage_begin "Storage Core readiness"
node scripts/storage-core-preflight.cjs || exit 1
stage_done
stage_begin "stop old service and release port"

# 旧 standalone 可能已释放监听端口，却因后台 consumer 定时器继续存活并占住 spool 锁。
# 等端口释放后再核对进程；Linux 僵尸进程需清除其遗留的全部 consumer 锁。
if ! node scripts/stop-orphan-trace-consumer.cjs "$AGENT_INSIGHT_HOME" "$(pwd)"; then
  echo "CRITICAL ERROR: 无法安全清理旧 Trace 消费进程，已停止启动。" >&2
  exit 1
fi

stage_done

# 4. Build
echo "-----------------------------------"
stage_begin "Prisma Client check/generate"
if node scripts/start-build-state.cjs prisma-check; then
  echo "Prisma Client unchanged; skipping generation."
else
  echo "Generating Prisma client..."
  npx prisma generate || exit 1
  node scripts/start-build-state.cjs prisma-record || exit 1
fi
stage_done

stage_begin "benchmark preparation"
if ! node scripts/benchmark/bootstrap-swe-bench-dataset.cjs; then
  echo "⚠ SWE-bench Verified 自动准备脚本执行失败，将继续启动服务；下次启动自动重试。" >&2
fi
if ! node scripts/benchmark/bootstrap-zsoft-dataset.cjs; then
  echo "⚠ ZSoft L1 自动准备脚本执行失败，将继续启动服务；下次启动自动重试。" >&2
fi

stage_done
stage_begin "build fingerprint and artifact check"
# Next.js 构建也会生成这些文件，必须在记录指纹前准备齐全。
node scripts/benchmark/generate-catalog.cjs || exit 1
node scripts/build-trace-dataset-worker.cjs || exit 1
node scripts/start-build-state.cjs check $FORCE_REBUILD
BUILD_STATUS=$?
[ "$BUILD_STATUS" -le 1 ] || exit "$BUILD_STATUS"
stage_done

if [ "$BUILD_STATUS" -eq 1 ]; then
  stage_begin "Next.js build (cache retained)"
  node scripts/start-build-state.cjs prepare || exit 1
  NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=4096}" npm run build -- --webpack || exit 1
  stage_done
else
  echo "Build unchanged and complete; skipping Next.js build."
fi

stage_begin "standalone preparation and verification"
STANDALONE_SERVER=$(find .next/standalone -maxdepth 2 -name server.js | head -n 1)
if [ -z "$STANDALONE_SERVER" ]; then
  echo "Missing standalone server.js; refusing to start."
  exit 1
fi
STANDALONE_DIR=$(dirname "$STANDALONE_SERVER")
if [ "$BUILD_STATUS" -eq 1 ]; then
  mkdir -p "$STANDALONE_DIR/.next/static" "$STANDALONE_DIR/public" || exit 1
  cp -a .next/static/. "$STANDALONE_DIR/.next/static/" || exit 1
  cp -a public/. "$STANDALONE_DIR/public/" || exit 1
fi
node scripts/verify-standalone.cjs "$STANDALONE_DIR" || exit 1
BASE_PATH=$(node -p 'require(require("node:path").resolve(process.argv[1])).config?.basePath || ""' \
  "$STANDALONE_DIR/.next/required-server-files.json") || exit 1
if [ "$BUILD_STATUS" -eq 1 ]; then
  node scripts/start-build-state.cjs record || exit 1
fi
stage_done

# 5. Start
echo "-----------------------------------"
stage_begin "start service and page health checks"
echo "Starting server (standalone)..."

# One last check before start
if [ -n "$(find_pid_on_port $PLATFORM_PORT)" ]; then
    echo "ERROR: Port $PLATFORM_PORT was taken during build!"
    exit 1
fi

# 运行时堆上限。注意机器 ~15G、opencode 满 5 slot ~4.5G,所以不能调太高(否则系统级 OOM-kill
# 比堆崩更难查)。6G = 在"真正的修复(评测重试不放大 + 评测行并发硬上限)"之外留点余量。
# HOSTNAME=0.0.0.0：standalone server 默认可能绑到非 loopback，WSL/代理下 curl 127.0.0.1 会 502。
# 必须在 standalone 目录下启动：server.js 相对解析 .next/static、public、node_modules。
export AGENT_INSIGHT_PACKAGE_ROOT="$(pwd)"
LOG_FILE="$AGENT_INSIGHT_HOME/logs/web.log"
NEW_PID=$(node scripts/local-runtime.cjs launch-web production "$PLATFORM_PORT" "$STANDALONE_DIR") || exit 1

echo "Waiting for port $PLATFORM_PORT to accept connections..."
HEALTH_URL="http://127.0.0.1:$PLATFORM_PORT$BASE_PATH"
READY=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
  sleep 1
  if curl --noproxy '*' -fsS -m 2 -o /dev/null -w '' "$HEALTH_URL/" >/dev/null 2>&1 \
    && curl --noproxy '*' -fsS -m 2 -o /dev/null -w '' "$HEALTH_URL/dataset" >/dev/null 2>&1 \
    && curl --noproxy '*' -fsS -m 2 -o /dev/null -w '' "$HEALTH_URL/fault" >/dev/null 2>&1; then
    READY=1
    break
  fi
done

if [ "$READY" -ne 1 ]; then
  echo "CRITICAL ERROR: Server process spawned (PID ${NEW_PID:-unknown}) but $HEALTH_URL 无响应。"
  echo "Check $LOG_FILE for details."
  tail -n 40 "$LOG_FILE" 2>/dev/null || true
  exit 1
fi

stage_done
echo "Server started successfully."
echo "PID: ${NEW_PID:-$(find_pid_on_port $PLATFORM_PORT | tr '\n' ' ')}"
echo "Standalone: $STANDALONE_DIR/server.js"
echo "Log file: $LOG_FILE"
echo "URL: http://localhost:$PLATFORM_PORT$BASE_PATH"
stage_begin "Goal Plus watcher"
ensure_goal_plus_watcher
stage_done
echo "-----------------------------------"
