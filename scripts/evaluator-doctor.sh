#!/usr/bin/env bash
set -euo pipefail

CONTAINER_NAME=agent-insight-benchmark-evaluator
CONFIG_FILE=${AGENT_INSIGHT_EVALUATOR_HOME:-$HOME/.agent-insight/evaluator}/evaluator.env
EXPECTED_IMAGE_ID=
SMOKE=

fail() {
  printf 'Evaluator Doctor 失败：%s\n' "$1" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --container|--config|--expected-image-id|--smoke)
      [ "$#" -ge 2 ] || fail "$1 缺少参数值"
      case "$1" in
        --container) CONTAINER_NAME=$2 ;;
        --config) CONFIG_FILE=$2 ;;
        --expected-image-id) EXPECTED_IMAGE_ID=$2 ;;
        --smoke) SMOKE=$2 ;;
      esac
      shift 2
      ;;
    --help|-h)
      printf 'Usage: bash scripts/evaluator-doctor.sh [--smoke <evaluator-key>]\n'
      exit 0
      ;;
    *) fail "不支持的参数：$1" ;;
  esac
done

command -v docker >/dev/null 2>&1 || fail '找不到 Docker CLI'
[ -f "$CONFIG_FILE" ] || fail "配置文件不存在：$CONFIG_FILE"
if [ "$(uname -s)" = Darwin ]; then
  CONFIG_MODE=$(stat -f '%Lp' "$CONFIG_FILE")
else
  CONFIG_MODE=$(stat -c '%a' "$CONFIG_FILE")
fi
[ "$CONFIG_MODE" = 600 ] || fail "配置文件权限必须为 0600，当前为 $CONFIG_MODE"

docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1 \
  || fail "Controller 容器不存在：$CONTAINER_NAME"
[ "$(docker container inspect "$CONTAINER_NAME" --format '{{.State.Running}}')" = true ] \
  || fail 'Controller 容器未运行'
ACTUAL_IMAGE_ID=$(docker container inspect "$CONTAINER_NAME" --format '{{.Image}}')
if [ -n "$EXPECTED_IMAGE_ID" ] && [ "$ACTUAL_IMAGE_ID" != "$EXPECTED_IMAGE_ID" ]; then
  fail "Controller image ID 不匹配：$ACTUAL_IMAGE_ID"
fi

if ! DOCTOR_OUTPUT=$(docker exec "$CONTAINER_NAME" node services/evaluator/src/cli.cjs doctor); then
  docker logs --tail 50 "$CONTAINER_NAME" >&2 || true
  fail '容器内 Doctor 未通过'
fi
printf '%s\n' "$DOCTOR_OUTPUT"

if [ -n "$SMOKE" ]; then
  printf '运行可选部署 Smoke（可能按需拉取一个 Case 镜像）：%s\n' "$SMOKE"
  docker exec "$CONTAINER_NAME" node services/evaluator/src/cli.cjs smoke --evaluator "$SMOKE"
fi
