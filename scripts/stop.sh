#!/bin/bash
#
# 停止 witty-skill-insight 的所有相关进程：
#   1. 占用 3000 端口的 Next.js server（生产 / dev 模式都管）
#   2. 通过 opencode-manager.ts spawn 出来的 opencode 子进程（包括之前 leak 的孤儿）
#
# 不会动用户机器上其它 opencode 实例（比如全局装的 / TUI 单独跑的）——
# 通过 node_modules 完整路径匹配，只杀本项目 spawn 的那些。

# 切到项目根
cd "$(dirname "$0")/.."

PORT=3000

echo "=== Stop Script Started ==="

find_pid_on_port() {
  local port=$1
  local pid=""
  if command -v lsof >/dev/null 2>&1; then
    pid=$(lsof -t -i:${port} -sTCP:LISTEN 2>/dev/null)
  fi
  if [ -z "$pid" ] && command -v netstat >/dev/null 2>&1; then
    pid=$(netstat -nlp 2>/dev/null | grep ":$port " | awk '{print $7}' | cut -d'/' -f1)
  fi
  if [ -z "$pid" ] && command -v ss >/dev/null 2>&1; then
    pid=$(ss -lptn "sport = :$port" 2>/dev/null | grep -oP 'pid=\K\d+')
  fi
  echo "$pid"
}

# 1. 杀 Next.js server
echo "Checking port $PORT..."
PIDS=$(find_pid_on_port $PORT)
if [ -n "$PIDS" ]; then
  echo "Found Next.js process(es) on port $PORT: $PIDS"
  kill -9 $PIDS 2>/dev/null || true
else
  echo "No process on port $PORT (Next.js already stopped or never started)."
fi

# 2. fuser 兜底（容器/Linux 常用）
if command -v fuser >/dev/null 2>&1; then
  fuser -k -n tcp $PORT >/dev/null 2>&1 || true
fi

# 3. 杀本项目 spawn 的 opencode 子进程（含孤儿）
PROJECT_OPENCODE_PATH="$(pwd)/node_modules/opencode-ai/bin"
if command -v pkill >/dev/null 2>&1; then
  ORPHAN_COUNT=$(pgrep -f "${PROJECT_OPENCODE_PATH}/.opencode" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$ORPHAN_COUNT" -gt 0 ]; then
    echo "Killing $ORPHAN_COUNT opencode child(ren) under $PROJECT_OPENCODE_PATH..."
    pkill -f "${PROJECT_OPENCODE_PATH}/.opencode" 2>/dev/null || true
    sleep 1
    # 二次确认，仍未死掉的强杀
    REMAINING=$(pgrep -f "${PROJECT_OPENCODE_PATH}/.opencode" 2>/dev/null | wc -l | tr -d ' ')
    if [ "$REMAINING" -gt 0 ]; then
      echo "Still alive: $REMAINING — sending SIGKILL..."
      pkill -9 -f "${PROJECT_OPENCODE_PATH}/.opencode" 2>/dev/null || true
    fi
  else
    echo "No opencode child processes from this project."
  fi
else
  echo "pkill not available — manually kill any remaining opencode children if needed."
fi

# 4. 验证
sleep 1
PIDS_REMAINING=$(find_pid_on_port $PORT)
OPENCODE_REMAINING=$(pgrep -f "${PROJECT_OPENCODE_PATH}/.opencode" 2>/dev/null | wc -l | tr -d ' ')

echo "-----------------------------------"
if [ -z "$PIDS_REMAINING" ] && [ "$OPENCODE_REMAINING" -eq 0 ]; then
  echo "✓ All services stopped cleanly."
  exit 0
else
  if [ -n "$PIDS_REMAINING" ]; then
    echo "✗ Port $PORT still occupied by PID: $PIDS_REMAINING (kill -9 $PIDS_REMAINING)"
  fi
  if [ "$OPENCODE_REMAINING" -gt 0 ]; then
    echo "✗ $OPENCODE_REMAINING opencode child(ren) still alive."
  fi
  exit 1
fi
