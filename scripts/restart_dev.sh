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

PORT=3000
echo "Checking port $PORT..."

# Check for OpenGauss configuration in .env
if [ -f .env ]; then
  # Load .env variables safely
  set -a
  source .env
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

# 4. Start in DEV mode
echo "-----------------------------------"
echo "Clearing Next.js dev cache (.next)..."
rm -rf .next

echo "Running ad-hoc SQLite column migrations..."
# 一次性、幂等的 SQLite 列改名步骤。集中放在 prisma db push 之前，
# 因为 db push 对 SQLite 的"重命名列"识别不可靠——不加 --accept-data-loss 会报错，
# 加了则把旧列里的数据直接丢掉。这里用 PRAGMA + ALTER TABLE RENAME COLUMN
# (SQLite 3.25+ 原生支持) 显式迁移，老数据原地保留。
# 仅在使用 SQLite（无 DB_HOST，即没配 OpenGauss）时跑。
if [ -z "$DB_HOST" ] && command -v sqlite3 >/dev/null 2>&1; then
  # DATABASE_URL 形如 "file:../data/witty_insight.db"（相对 prisma/ 目录），
  # 从项目根落到 data/witty_insight.db。从 .env 解析；缺省 fallback。
  DB_PATH=$(grep -E '^DATABASE_URL=' .env 2>/dev/null | sed -E 's/^DATABASE_URL=//; s/^"//; s/"$//; s|^file:\.\./|./|; s|^file:||')
  if [ -z "$DB_PATH" ]; then
    DB_PATH="data/witty_insight.db"
  fi
  if [ -f "$DB_PATH" ]; then
    # 召回 → 触发：把历史 Execution.skillRecallRate 改名成 skillTriggerRate。
    # 幂等：先 PRAGMA 检查旧列还在不在；不在就直接跳过。新数据库（prisma db push
    # 已造出 skillTriggerRate）也无副作用。
    if sqlite3 "$DB_PATH" "PRAGMA table_info(Execution);" | grep -q "|skillRecallRate|"; then
      echo "  [migrate] Renaming Execution.skillRecallRate → skillTriggerRate ($DB_PATH)..."
      sqlite3 "$DB_PATH" "ALTER TABLE Execution RENAME COLUMN skillRecallRate TO skillTriggerRate;"
    fi

    # A/B 测试：GrayscaleTask 增加 skill 绑定四列（schema 是 NOT NULL）。
    # 直接让 prisma db push 加 NOT NULL 列会弹 "reset database?" 提示——回车默认 Yes
    # 会整库清空（不只是 GrayscaleTask）。
    # 复用团队已有的 scripts/cleanup_grayscale_skill_binding.ts：它会
    #   1) ADD COLUMN（SQLite 只支持加 nullable 列）
    #   2) 从 configJson 反推 skillId/versionBId，JOIN Skill/SkillVersion 拿 name/version
    #   3) 删除 configJson 没有有效 skill 引用的「孤儿行」（A/B 上线前的脏数据）
    #   4) 按 (user, skillName, skillVersion) 去重，保留每组 createdAt 最新一条
    #   5) 重建相关索引
    # 之后 prisma db push 看到列已存在 + 无 NULL，会静默把列升级到 NOT NULL。
    if [ -f scripts/cleanup_grayscale_skill_binding.ts ]; then
      # 仅当 GrayscaleTask 还有 NULL 绑定列（或四列尚未加）时才跑，避免每次重启都做无谓 IO。
      NEEDS_CLEANUP=0
      if ! sqlite3 "$DB_PATH" "PRAGMA table_info(GrayscaleTask);" | grep -q "|skillId|"; then
        NEEDS_CLEANUP=1
      elif [ "$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM GrayscaleTask WHERE skillId IS NULL OR skillName IS NULL OR skillVersion IS NULL OR skillVersionId IS NULL;")" != "0" ]; then
        NEEDS_CLEANUP=1
      fi
      if [ "$NEEDS_CLEANUP" = "1" ]; then
        echo "  [migrate] Running cleanup_grayscale_skill_binding.ts (backfill + 删孤儿 + 去重)..."
        if ! npx tsx scripts/cleanup_grayscale_skill_binding.ts; then
          echo ""
          echo "  ⛔ cleanup_grayscale_skill_binding.ts 失败。"
          echo "     直接放行会让 prisma db push 弹出 reset 提示并清掉整个数据库。"
          echo "     请检查上方报错（常见原因：prisma client 没 generate → 跑 'npx prisma generate'）。"
          exit 1
        fi
        REMAINING=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM GrayscaleTask WHERE skillId IS NULL OR skillName IS NULL OR skillVersion IS NULL OR skillVersionId IS NULL;")
        if [ "$REMAINING" != "0" ]; then
          echo ""
          echo "  ⛔ Backfill 后仍有 $REMAINING 行 GrayscaleTask 字段为 NULL（脚本未能清理干净）。"
          echo "     直接放行 prisma db push 会弹出 reset 提示——回车默认 Yes 会清整库数据。"
          echo "     问题行 (id | user | taskName | configJson 前 200 字):"
          sqlite3 "$DB_PATH" "SELECT '    ' || id || ' | ' || user || ' | ' || taskName || ' | ' || substr(configJson, 1, 200) FROM GrayscaleTask WHERE skillId IS NULL OR skillName IS NULL OR skillVersion IS NULL OR skillVersionId IS NULL;"
          echo ""
          echo "     处理后再跑 bash scripts/restart_dev.sh。"
          exit 1
        fi
      fi
    fi
  fi
fi

echo "Syncing database schema..."
if ! npx prisma db push; then
  echo ""
  echo "  ⛔ prisma db push 失败 —— 数据库 schema 没同步成功。"
  echo "     直接启动 server 会让运行时撞到 schema/code 不一致（旧 client 查不到的列等）。"
  echo "     退出脚本。修好后重新跑 bash scripts/restart_dev.sh。"
  exit 1
fi

echo "Generating Prisma client..."
if ! npx prisma generate; then
  echo ""
  echo "  ⛔ prisma generate 失败 —— Prisma Client 没更新，但 schema 已同步。"
  echo "     启动 server 会用旧 client 查新表，所有数据 API 都会挂。"
  echo "     常见原因：node_modules 里有 root 拥有的文件（之前用 sudo npm install 过）。"
  echo "     修法："
  echo "       sudo chown -R \"\$(whoami)\":staff node_modules/.prisma node_modules/@prisma"
  echo "       bash scripts/restart_dev.sh"
  echo "     退出脚本。"
  exit 1
fi

echo "Starting server in DEVELOPMENT mode (npm run dev)..."

# Ensure environment variables are exported for the Node process
set -a
if [ -f .env ]; then
  source .env
fi
set +a

# Debug: Print DB_HOST to confirm it's visible
echo "DB_HOST for server: $DB_HOST"

nohup npm run dev > server.log 2>&1 &
NEW_PID=$!

echo "Server started successfully."
echo "PID: $NEW_PID"
echo "Log file: server.log"
echo "-----------------------------------"
