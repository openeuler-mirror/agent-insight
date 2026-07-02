#!/bin/sh
set -eu

: "${PORT:=3000}"
: "${HOSTNAME:=0.0.0.0}"
: "${AGENT_INSIGHT_DATA_DIR:=/data/agent-insight}"
: "${OPENCODE_BIN:=/app/node_modules/.bin/opencode}"

PACKAGE_ROOT="/app/node_modules/agent-insight"
ENV_FILE="$AGENT_INSIGHT_DATA_DIR/.env"

mkdir -p "$AGENT_INSIGHT_DATA_DIR/data"

if [ ! -f "$ENV_FILE" ] && [ -f "$PACKAGE_ROOT/.env.example" ]; then
  cp "$PACKAGE_ROOT/.env.example" "$ENV_FILE"
fi

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

export PORT
export HOSTNAME
export AGENT_INSIGHT_DATA_DIR
export PATH="/app/node_modules/.bin:$PATH"

if [ -x "$OPENCODE_BIN" ]; then
  export OPENCODE_BIN
  echo "Using opencode binary: $OPENCODE_BIN"
else
  echo "Error: opencode binary not found at $OPENCODE_BIN" >&2
  exit 1
fi

case "${DATABASE_URL:-}" in
  ""|"file:../data/witty_insight.db")
    export DATABASE_URL="file:$AGENT_INSIGHT_DATA_DIR/data/witty_insight.db"
    ;;
esac

cd "$PACKAGE_ROOT"

if [ -n "${DB_HOST:-}" ]; then
  echo "Error: this Docker image is SQLite-first and does not include OpenGauss runtime dependencies." >&2
  echo "Unset DB_HOST (use SQLite), or build a dedicated OpenGauss-enabled image." >&2
  exit 1
else
  npx prisma db push
fi

npx prisma generate

exec node .next/standalone/server.js
