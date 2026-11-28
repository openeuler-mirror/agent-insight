#!/bin/sh
set -eu

# 分步实例的参数集中在这里。端口和凭据在首次启动时保存。
transaction=${STEP_TRANSACTION:-postgresql}
instance_dir=${STEP_INSTANCE_DIR:-"$HOME/.agent-insight-docker-step"}
export WEB_HOST_PORT=${WEB_HOST_PORT:-13000}
export PG_HOST_PORT=${PG_HOST_PORT:-25432}
export OG_HOST_PORT=${OG_HOST_PORT:-25433}
export SQLITE_HOST_PORT=${SQLITE_HOST_PORT:-28080}
export CH_HOST_PORT=${CH_HOST_PORT:-28123}

if [ "$#" -ne 1 ]; then
  echo '用法: bash scripts/deploy-step.sh clickhouse|transaction|app|status|stop' >&2
  exit 2
fi
case "$1" in
  clickhouse|transaction) set -- db --service "$1" --transaction "$transaction" ;;
  app|status|stop) ;;
  *) echo "未知步骤: $1" >&2; exit 2 ;;
esac
exec sh "$(dirname "$0")/deploy-docker.sh" "$@" --instance-dir "$instance_dir"
