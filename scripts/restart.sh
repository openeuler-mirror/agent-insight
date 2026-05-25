#!/bin/bash

# Enable verbose mode to see what's happening
# set -x

# Navigate to the project root directory
cd "$(dirname "$0")/.."

# Auto-initialize environment and data directory
if [ ! -f .env ] && [ -f .env.example ]; then
  echo "No .env found. Initializing from .env.example..."
  cp .env.example .env
fi

if [ ! -d data ]; then
  echo "Creating data directory..."
  mkdir -p data
fi

echo "=== Restart Script Started ==="

# Function to find PID using various tools
find_pid_on_port() {
  local port=$1
  local pid=""
  
  if command -v lsof >/dev/null 2>&1; then
    pid=$(lsof -t -i:$port)
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

PORT=3000
echo "Checking port $PORT..."

# Check for OpenGauss configuration in .env
if [ -f .env ]; then
  # Load .env variables safely
  set -a
  . .env
  set +a
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
npx prisma db push

echo "Generating Prisma client..."
npx prisma generate

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

nohup npm run start > server.log 2>&1 &
NEW_PID=$!

echo "Server started successfully."
echo "PID: $NEW_PID"
echo "Log file: server.log"
echo "-----------------------------------"
