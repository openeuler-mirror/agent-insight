#!/usr/bin/env bash

evaluator_management_lock() {
  EVALUATOR_MANAGEMENT_HOME=${AGENT_INSIGHT_EVALUATOR_HOME:-$HOME/.agent-insight/evaluator}
  mkdir -p "$EVALUATOR_MANAGEMENT_HOME"
  EVALUATOR_MANAGEMENT_LOCK=$EVALUATOR_MANAGEMENT_HOME/management.lock
  if ! mkdir "$EVALUATOR_MANAGEMENT_LOCK" 2>/dev/null; then
    printf '已有启动或停止操作，或遗留管理锁：%s；确认没有管理进程后再处理。\n' "$EVALUATOR_MANAGEMENT_LOCK" >&2
    return 1
  fi
  trap 'rmdir "$EVALUATOR_MANAGEMENT_LOCK"' EXIT
}

evaluator_management_run() {
  local management_image=$1
  shift
  if ! docker run --rm --pull never --network none --read-only --entrypoint node \
    "$management_image" -e 'if (typeof require("/app/services/evaluator/src/manage.cjs").manage !== "function") process.exit(1)' >/dev/null; then
    printf '无法加载镜像内的管理工具；尚未执行停止或清理。旧版镜像请先用当前代码运行 start-evaluator.sh 构建并重建服务；若为 Docker 错误，请先排查上方报错。\n' >&2
    return 1
  fi
  docker run --rm --pull never --network none --entrypoint node \
    --env "EVALUATOR_INSTANCE_ID=$CONTAINER_NAME" \
    --env "EVALUATOR_VOLUME=$DATA_VOLUME" \
    --env "EVALUATOR_IMAGE_REFERENCE=${IMAGE_TAG:-}" \
    --mount "type=bind,src=$DOCKER_SOCKET,dst=/var/run/docker.sock" \
    --mount "type=volume,src=$DATA_VOLUME,dst=/data${MANAGEMENT_READONLY:-}" \
    "$management_image" /app/services/evaluator/src/manage.cjs "$@"
}
