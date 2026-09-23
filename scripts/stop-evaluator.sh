#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPOSITORY_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
CONTAINER_NAME=agent-insight-benchmark-evaluator
DATA_VOLUME=agent-insight-benchmark-evaluator-data
PURGE=false
DRY_RUN=false
for argument in "$@"; do
  case "$argument" in
    --purge-images) PURGE=true ;;
    --dry-run) DRY_RUN=true ;;
    --help|-h) printf 'Usage: bash scripts/stop-evaluator.sh [--purge-images] [--dry-run]\n'; exit 0 ;;
    *) printf '未知参数：%s\n' "$argument" >&2; exit 1 ;;
  esac
done
source "$SCRIPT_DIR/evaluator-management.sh"
docker info >/dev/null
DOCKER_CONTEXT=$(docker context show)
SOCKET_URL=${DOCKER_HOST:-$(docker context inspect "$DOCKER_CONTEXT" --format '{{.Endpoints.docker.Host}}')}
case "$SOCKET_URL" in
  unix:///*) DOCKER_SOCKET=${SOCKET_URL#unix://} ;;
  *) printf '仅支持当前主机 Unix Docker socket，不自动操作远端主机。\n' >&2; exit 1 ;;
esac
EVALUATOR_MANAGEMENT_HOME=${AGENT_INSIGHT_EVALUATOR_HOME:-$HOME/.agent-insight/evaluator}
CONFIG_FILE=$EVALUATOR_MANAGEMENT_HOME/evaluator.env
DAEMON_ID=$(docker info --format '{{.ID}}')
MANAGEMENT_IMAGE=$(docker container inspect "$CONTAINER_NAME" --format '{{.Image}}' 2>/dev/null || true)
if [ -z "$MANAGEMENT_IMAGE" ] && [ -f "$CONFIG_FILE" ]; then
  MANAGEMENT_IMAGE=$(awk -F= '$1 == "EVALUATOR_CONTROLLER_IMAGE_ID" { print $2 }' "$CONFIG_FILE" | tail -1)
fi
if ! docker volume inspect "$DATA_VOLUME" >/dev/null 2>&1; then
  if [ -z "$MANAGEMENT_IMAGE" ]; then printf '未发现评测服务部署，无需停止。\n'; exit 0; fi
  printf '缺少登记数据卷，拒绝猜测资源归属。\n' >&2; exit 1
fi
if [ -z "$MANAGEMENT_IMAGE" ] || ! docker image inspect "$MANAGEMENT_IMAGE" >/dev/null 2>&1; then
  if [ -f "$EVALUATOR_MANAGEMENT_HOME/purge-completed" ] \
    && [ "$(head -1 "$EVALUATOR_MANAGEMENT_HOME/purge-completed")" = "$DAEMON_ID|$MANAGEMENT_IMAGE" ] \
    && [ -z "$(docker ps -aq --filter "label=agent-insight.evaluator-instance=$CONTAINER_NAME")" ] \
    && ! docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
    printf '服务已停止；上次镜像清理已完成。数据卷和配置保留。\n'
    exit 0
  fi
  printf '缺少离线管理运行镜像，无法核对数据卷；请使用包含管理工具的本地 Controller 镜像恢复管理环境。\n' >&2
  exit 1
fi
MANAGEMENT_ARGS=()
[ "$PURGE" = false ] || MANAGEMENT_ARGS+=(--purge-images)
if [ "$DRY_RUN" = true ]; then
  MANAGEMENT_READONLY=,readonly
  MANAGEMENT_ARGS+=(--dry-run)
  evaluator_management_run "$MANAGEMENT_IMAGE" "${MANAGEMENT_ARGS[@]}"
  exit 0
fi
evaluator_management_lock
MANAGEMENT_OUTPUT=$(mktemp "${TMPDIR:-/tmp}/evaluator-stop.XXXXXX")
trap 'rm -f "$MANAGEMENT_OUTPUT"; rmdir "$EVALUATOR_MANAGEMENT_LOCK"' EXIT
RESULT=0
evaluator_management_run "$MANAGEMENT_IMAGE" "${MANAGEMENT_ARGS[@]}" > "$MANAGEMENT_OUTPUT" || RESULT=$?
cat "$MANAGEMENT_OUTPUT"
if [ "$PURGE" = true ]; then
  while IFS=$'\t' read -r marker expected_id reference; do
    [ "$marker" = CONTROLLER_IMAGE ] || continue
    actual_id=$(docker image inspect "$reference" --format '{{.Id}}' 2>/dev/null || true)
    [ -n "$actual_id" ] || continue
    if [ "$actual_id" != "$expected_id" ]; then
      printf '跳过已变更的 Controller 引用：%s\n' "$reference" >&2
      RESULT=2
    elif ! docker image rm "$reference"; then RESULT=2
    fi
  done < "$MANAGEMENT_OUTPUT"
fi
if [ "$PURGE" = true ] && [ "$RESULT" -eq 0 ]; then
  printf '%s|%s\n' "$DAEMON_ID" "$MANAGEMENT_IMAGE" > "$EVALUATOR_MANAGEMENT_HOME/purge-completed"
fi
exit "$RESULT"
