#!/bin/bash

# Enable verbose mode to see what's happening
# set -x

# Navigate to the project root directory
cd "$(dirname "$0")/.."

AGENT_INSIGHT_HOME="${AGENT_INSIGHT_DATA_DIR:-$HOME/.agent-insight}"
AGENT_INSIGHT_ENV_FILE="$AGENT_INSIGHT_HOME/.env"
AGENT_INSIGHT_DATA_DIR="$AGENT_INSIGHT_HOME/data"
DEFAULT_DATABASE_URL='file:../data/witty_insight.db'

load_agent_insight_env() {
  if [ -f "$AGENT_INSIGHT_ENV_FILE" ]; then
    set -a
    . "$AGENT_INSIGHT_ENV_FILE"
    set +a
  fi

  if [ -z "${DATABASE_URL:-}" ] || [ "$DATABASE_URL" = "$DEFAULT_DATABASE_URL" ]; then
    export DATABASE_URL="file:$AGENT_INSIGHT_DATA_DIR/witty_insight.db"
  elif [[ "$DATABASE_URL" == file:\~* ]]; then
    export DATABASE_URL="file:$HOME${DATABASE_URL#file:\~}"
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
fi

if [ ! -d "$AGENT_INSIGHT_DATA_DIR" ]; then
  echo "Creating data directory at $AGENT_INSIGHT_DATA_DIR..."
  mkdir -p "$AGENT_INSIGHT_DATA_DIR"
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

PORT=3000
echo "Checking port $PORT..."

# Check for OpenGauss configuration in ~/.agent-insight/.env
load_agent_insight_env

if [[ "${DATABASE_URL:-}" == file:* ]]; then
  echo "SQLite database target: ${DATABASE_URL#file:}"
else
  echo "Using custom database configuration."
fi

if [ -n "$DB_HOST" ]; then
  echo "OpenGauss configuration detected (DB_HOST=$DB_HOST)."
  echo "Initializing OpenGauss database with project schema..."
  
  # Ensure psycopg2 is installed
  if ! python3 -c "import psycopg2" >/dev/null 2>&1; then
    echo "psycopg2 not found. Installing psycopg2-binary..."
    pip3 install psycopg2-binary
  fi
  
  # Run the initialization script
  python3 scripts/init_opengauss.py
  if [ $? -ne 0 ]; then
    echo "OpenGauss initialization failed! Aborting."
    exit 1
  fi
  echo "OpenGauss initialized successfully."
else
  echo "No OpenGauss configuration (DB_HOST) found. Skipping OpenGauss init."
fi

# 1. Try finding PID specifically
PIDS=$(find_pid_on_port $PORT)

if [ -n "$PIDS" ]; then
  echo "Found process(es) occupying port $PORT: $PIDS"
  echo "Killing PIDS..."
  kill -9 $PIDS
else
  echo "No PID found via standard tools (lsof/netstat/ss)."
fi

# 1.5 清理孤儿 opencode 子进程
# Next.js 通过 opencode-manager.ts spawn 一组 `opencode serve` 子进程作为内部
# AI runtime（playground/skill-gen 等用）。SIGKILL Next.js 时这些子进程不会跟着死，
# 多次 restart 后会 leak 一堆，占内存、占端口、阻碍新启动。
# 通过 node_modules 路径匹配，只清掉本项目 spawn 的那些；不影响用户机器上其它 opencode 实例。
PROJECT_OPENCODE_PATH="$(pwd)/node_modules/opencode-ai/bin"
if command -v pkill >/dev/null 2>&1; then
  ORPHAN_COUNT=$(pgrep -f "${PROJECT_OPENCODE_PATH}/.opencode" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$ORPHAN_COUNT" -gt 0 ]; then
    echo "Killing $ORPHAN_COUNT orphan opencode child(ren) from $PROJECT_OPENCODE_PATH..."
    pkill -f "${PROJECT_OPENCODE_PATH}/.opencode" 2>/dev/null || true
    sleep 1
  fi
fi

# 2. Force kill using fuser if available (very reliable)
if command -v fuser >/dev/null 2>&1; then
  echo "Attempting to force kill with fuser..."
  fuser -k -n tcp $PORT >/dev/null 2>&1
fi

# 3. Double check
echo "Waiting for port to release..."
sleep 2

PIDS_REMAINING=$(find_pid_on_port $PORT)
if [ -n "$PIDS_REMAINING" ]; then
  echo "CRITICAL ERROR: Port $PORT is STILL in use by PID: $PIDS_REMAINING"
  echo "Please manually kill this process: kill -9 $PIDS_REMAINING"
  exit 1
fi

echo "Port $PORT is confirmed free."

# 4. Build
echo "-----------------------------------"
echo "Clearing Next.js build cache (.next)..."
rm -rf .next

echo "Syncing database schema..."
if [[ "${DATABASE_URL:-}" == file:* ]]; then
  if ! node scripts/prepare-ras-sqlite-schema.js; then
    echo "  ⛔ Agent RAS SQLite schema 预检失败，已停止启动以避免重复事件被错误合并。"
    exit 1
  fi
fi
if ! npx prisma db push; then
  echo ""
  echo "  ⛔ prisma db push 失败 —— 数据库 schema 没同步成功。"
  echo "     直接启动 server 会让运行时撞到 schema/code 不一致。"
  echo "     退出脚本。修好后重新跑 bash scripts/start.sh。"
  exit 1
fi

echo "Generating Prisma client..."
if ! npx prisma generate; then
  echo ""
  echo "  ⛔ prisma generate 失败 —— Prisma Client 没更新，但 schema 已同步。"
  echo "     启动 server 会用旧 client 查新表，所有数据 API 都可能挂。"
  echo "     退出脚本。修好后重新跑 bash scripts/start.sh。"
  exit 1
fi

echo "Building project..."
# Limit Node memory to 2GB to prevent OOM kills on small servers
NODE_OPTIONS="--max-old-space-size=2048" npm run build
if [ $? -ne 0 ]; then
    echo "Build failed! Aborting."
    exit 1
fi

# 5. Start
echo "-----------------------------------"
echo "Starting server..."

# One last check before start
if [ -n "$(find_pid_on_port $PORT)" ]; then
    echo "ERROR: Port $PORT was taken during build!"
    exit 1
fi

# 运行时堆上限。注意机器 ~15G、opencode 满 5 slot ~4.5G,所以不能调太高(否则系统级 OOM-kill
# 比堆崩更难查)。6G = 在"真正的修复(评测重试不放大 + 评测行并发硬上限)"之外留点余量。
NODE_OPTIONS="--max-old-space-size=6144" nohup npm run start > server.log 2>&1 &
NEW_PID=$!

echo "Server started successfully."
echo "PID: $NEW_PID"
echo "Log file: server.log"
echo "-----------------------------------"
