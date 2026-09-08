#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPOSITORY_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
CONTAINER_NAME=agent-insight-benchmark-evaluator
DATA_VOLUME=agent-insight-benchmark-evaluator-data
BIND_ADDRESS=0.0.0.0
PORT=8080
AUTH_MODE=token
TOKEN=
CASE_IMAGE_PROXY_PREFIX=${SWE_BENCH_IMAGE_PROXY_PREFIX-docker.1ms.run}

usage() {
  cat <<'EOF'
Usage:
  bash scripts/start-evaluator.sh [--auth-mode token --token TOKEN | --auth-mode none] [--bind-address ADDRESS] [--port PORT]

Starts the Evaluator Controller from the current Git checkout on Linux or macOS.
The command does not pull source code, register with Agent Insight, or preload Case images.
EOF
}

fail() {
  printf 'Evaluator 启动失败：%s\n' "$1" >&2
  exit 1
}

git_checkout() {
  git -c "safe.directory=$REPOSITORY_ROOT" -C "$REPOSITORY_ROOT" "$@"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --token|--auth-mode|--bind-address|--port)
      [ "$#" -ge 2 ] || fail "$1 缺少参数值"
      case "$1" in
        --token) TOKEN=$2 ;;
        --auth-mode) AUTH_MODE=$2 ;;
        --bind-address) BIND_ADDRESS=$2 ;;
        --port) PORT=$2 ;;
      esac
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *) fail "不支持的参数：$1" ;;
  esac
done

case "$AUTH_MODE" in
  token)
    [ -n "$TOKEN" ] || fail 'token 模式必须提供 --token'
    case "$TOKEN" in
      eval_once_*) fail '一期不接受一次性 eval_once_* Token，请使用双方一致的共享密钥' ;;
    esac
    if printf '%s' "$TOKEN" | LC_ALL=C grep -q '[[:space:],]'; then
      fail 'Token 必须是不含空白或逗号的单行值'
    fi
    ;;
  none)
    [ -z "$TOKEN" ] || fail 'none 模式不接受 --token'
    ;;
  *) fail '--auth-mode 必须是 token 或 none' ;;
esac
case "$PORT" in
  ''|*[!0-9]*) fail '--port 必须是 1～65535 的整数' ;;
esac
[ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || fail '--port 必须是 1～65535 的整数'
if ! printf '%s' "$BIND_ADDRESS" | LC_ALL=C grep -Eq '^[A-Za-z0-9.:-]+$'; then
  fail '--bind-address 包含不支持的字符'
fi
if [ -n "$CASE_IMAGE_PROXY_PREFIX" ] \
  && ! printf '%s' "$CASE_IMAGE_PROXY_PREFIX" | LC_ALL=C grep -Eq '^[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._-]+)*$'; then
  fail 'SWE_BENCH_IMAGE_PROXY_PREFIX 必须是无协议的镜像仓库前缀，设置为空可禁用'
fi

for command_name in git docker df; do
  command -v "$command_name" >/dev/null 2>&1 || fail "宿主缺少命令：$command_name"
done

HOST_UNAME=$(uname -s)
case "$HOST_UNAME" in
  Linux) HOST_OS=linux ;;
  Darwin) HOST_OS=darwin ;;
  *) fail "不支持的宿主系统：$HOST_UNAME（仅支持 Linux 与 macOS）" ;;
esac

HOST_UNAME_ARCH=$(uname -m)
case "$HOST_UNAME_ARCH" in
  x86_64|amd64) HOST_ARCH=x86_64 ;;
  arm64|aarch64) HOST_ARCH=arm64 ;;
  *) fail "不支持的宿主架构：$HOST_UNAME_ARCH" ;;
esac

git_checkout rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || fail '当前目录不是 Git checkout'
SOURCE_REVISION=$(git_checkout rev-parse --verify HEAD 2>/dev/null) \
  || fail '无法读取当前 Git commit'
SOURCE_DIRTY=false
if [ -n "$(git_checkout status --porcelain --untracked-files=normal)" ]; then
  SOURCE_DIRTY=true
  printf '警告：当前 Git checkout 含未提交内容；本次镜像将标记为 dirty，不视为该 commit 的可复现发布构建。\n' >&2
fi
[ -f "$REPOSITORY_ROOT/generated/benchmark-catalog/evaluators.cjs" ] \
  || fail '缺少构建生成的 Evaluator Catalog；发布 revision 必须包含 generated/benchmark-catalog/evaluators.cjs'

AVAILABLE_KB=$(df -Pk "$REPOSITORY_ROOT" 2>/dev/null | awk 'END { print $4 }')
case "$AVAILABLE_KB" in
  ''|*[!0-9]*) fail '无法读取可用磁盘空间' ;;
esac
MIN_FREE_KB=${EVALUATOR_MIN_FREE_KB:-1048576}
[ "$AVAILABLE_KB" -ge "$MIN_FREE_KB" ] \
  || fail "可用磁盘空间不足（至少需要 $MIN_FREE_KB KiB，当前 $AVAILABLE_KB KiB）"

docker info >/dev/null 2>&1 || fail 'Docker daemon 不可用；macOS 请先启动 Docker Desktop'
DOCKER_CONTEXT=$(docker context show 2>/dev/null || true)
SOCKET_URL=$(docker context inspect "$DOCKER_CONTEXT" --format '{{.Endpoints.docker.Host}}' 2>/dev/null || true)
if [ -z "$SOCKET_URL" ] && [ -n "${DOCKER_HOST:-}" ]; then SOCKET_URL=$DOCKER_HOST; fi
if [ -z "$SOCKET_URL" ]; then SOCKET_URL=unix:///var/run/docker.sock; fi
case "$SOCKET_URL" in
  unix://*) DOCKER_SOCKET=${SOCKET_URL#unix://} ;;
  *) fail "当前 Docker context 使用远程 daemon，无法挂载 Socket：$SOCKET_URL" ;;
esac
[ -S "$DOCKER_SOCKET" ] || fail "Docker Socket 不存在或不是 Unix Socket：$DOCKER_SOCKET"

SHORT_REVISION=$(printf '%s' "$SOURCE_REVISION" | cut -c1-12)
DIRTY_SUFFIX=
if [ "$SOURCE_DIRTY" = true ]; then DIRTY_SUFFIX=-dirty; fi
IMAGE_TAG="agent-insight-benchmark-evaluator:src-$SHORT_REVISION$DIRTY_SUFFIX"
if [ "$SOURCE_DIRTY" = true ] || ! docker image inspect "$IMAGE_TAG" >/dev/null 2>&1; then
  printf '构建 Evaluator Controller：%s\n' "$IMAGE_TAG"
  docker build \
    --file "$REPOSITORY_ROOT/services/evaluator/Dockerfile" \
    --build-arg "EVALUATOR_SOURCE_REVISION=$SOURCE_REVISION" \
    --build-arg "EVALUATOR_SOURCE_DIRTY=$SOURCE_DIRTY" \
    --tag "$IMAGE_TAG" \
    "$REPOSITORY_ROOT"
else
  printf '复用当前 revision 的 Controller 镜像：%s\n' "$IMAGE_TAG"
fi
IMAGE_ID=$(docker image inspect "$IMAGE_TAG" --format '{{.Id}}')
[ -n "$IMAGE_ID" ] || fail '无法读取 Controller image ID'

EVALUATOR_HOME=${AGENT_INSIGHT_EVALUATOR_HOME:-$HOME/.agent-insight/evaluator}
CONFIG_FILE=$EVALUATOR_HOME/evaluator.env
mkdir -p "$EVALUATOR_HOME"
chmod 700 "$EVALUATOR_HOME"
umask 077
TEMP_CONFIG=$EVALUATOR_HOME/.evaluator.env.$$
trap 'rm -f "$TEMP_CONFIG"' EXIT
{
  printf 'EVALUATOR_LISTEN_HOST=0.0.0.0\n'
  printf 'EVALUATOR_PORT=8080\n'
  printf 'EVALUATOR_DATA_DIR=/data\n'
  printf 'EVALUATOR_MAX_CONCURRENCY=1\n'
  printf 'EVALUATOR_AUTH_MODE=%s\n' "$AUTH_MODE"
  printf 'EVALUATOR_PLATFORM_TOKEN=%s\n' "$TOKEN"
  printf 'SWE_BENCH_IMAGE_SOURCE=official\n'
  printf 'SWE_BENCH_IMAGE_PROXY_PREFIX=%s\n' "$CASE_IMAGE_PROXY_PREFIX"
  printf 'SWE_BENCH_IMAGE_ARCH=auto\n'
  printf 'SWE_BENCH_ALLOW_NON_OFFICIAL=false\n'
  printf 'EVALUATOR_HOST_OS=%s\n' "$HOST_OS"
  printf 'EVALUATOR_HOST_ARCH=%s\n' "$HOST_ARCH"
  printf 'EVALUATOR_SOURCE_REVISION=%s\n' "$SOURCE_REVISION"
  printf 'EVALUATOR_SOURCE_DIRTY=%s\n' "$SOURCE_DIRTY"
  printf 'EVALUATOR_CONTROLLER_IMAGE_ID=%s\n' "$IMAGE_ID"
} > "$TEMP_CONFIG"
chmod 600 "$TEMP_CONFIG"

CONFIG_CHANGED=1
if [ -f "$CONFIG_FILE" ] && cmp -s "$TEMP_CONFIG" "$CONFIG_FILE"; then CONFIG_CHANGED=0; fi
mv -f "$TEMP_CONFIG" "$CONFIG_FILE"
chmod 600 "$CONFIG_FILE"
trap - EXIT
CONFIG_DIGEST=$(git_checkout hash-object --no-filters "$CONFIG_FILE")

docker volume create "$DATA_VOLUME" >/dev/null
EXISTING_IMAGE=
EXISTING_CONFIG=
EXISTING_RUNNING=false
if docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  EXISTING_IMAGE=$(docker container inspect "$CONTAINER_NAME" --format '{{.Image}}')
  EXISTING_CONFIG=$(docker container inspect "$CONTAINER_NAME" --format '{{ index .Config.Labels "agent-insight.evaluator.config-digest" }}')
  EXISTING_RUNNING=$(docker container inspect "$CONTAINER_NAME" --format '{{.State.Running}}')
fi

if [ "$EXISTING_IMAGE" = "$IMAGE_ID" ] && [ "$EXISTING_CONFIG" = "$CONFIG_DIGEST" ]; then
  if [ "$EXISTING_RUNNING" != true ]; then docker start "$CONTAINER_NAME" >/dev/null; fi
  if [ "$CONFIG_CHANGED" -eq 0 ]; then printf '现有 Controller 配置未变化，执行恢复检查。\n'; fi
else
  if [ -n "$EXISTING_IMAGE" ]; then docker rm -f "$CONTAINER_NAME" >/dev/null; fi
  printf '启动 Evaluator Controller 容器：%s\n' "$CONTAINER_NAME"
  docker run --detach --pull never \
    --name "$CONTAINER_NAME" \
    --restart unless-stopped \
    --label "agent-insight.evaluator.config-digest=$CONFIG_DIGEST" \
    --add-host host.docker.internal:host-gateway \
    --env-file "$CONFIG_FILE" \
    --mount "type=bind,src=$DOCKER_SOCKET,dst=/var/run/docker.sock" \
    --mount "type=volume,src=$DATA_VOLUME,dst=/data" \
    --publish "$BIND_ADDRESS:$PORT:8080" \
    "$IMAGE_TAG" >/dev/null
fi

bash "$SCRIPT_DIR/evaluator-doctor.sh" \
  --container "$CONTAINER_NAME" \
  --config "$CONFIG_FILE" \
  --expected-image-id "$IMAGE_ID"

printf '\nEvaluator Controller 已就绪。\n'
printf 'Source revision: %s\n' "$SOURCE_REVISION"
printf 'Source dirty: %s\n' "$SOURCE_DIRTY"
printf 'Controller image ID: %s\n' "$IMAGE_ID"
printf 'Auth mode: %s\n' "$AUTH_MODE"
printf 'Listen: %s:%s\n' "$BIND_ADDRESS" "$PORT"
printf 'Data volume: %s\n' "$DATA_VOLUME"
printf 'Agent Insight 侧配置示例：\n'
printf '  AGENT_INSIGHT_BENCHMARK_EVALUATOR_BASE_URL=https://<evaluator-host>:%s\n' "$PORT"
printf '  AGENT_INSIGHT_BENCHMARK_EVALUATOR_AUTH_MODE=%s\n' "$AUTH_MODE"
if [ "$AUTH_MODE" = token ]; then
  printf '  AGENT_INSIGHT_BENCHMARK_EVALUATOR_TOKEN=<same-shared-secret>\n'
fi
printf '日志：docker logs -f %s\n' "$CONTAINER_NAME"
printf '重启：docker restart %s\n' "$CONTAINER_NAME"
printf 'Smoke：bash scripts/evaluator-doctor.sh --smoke swe-bench\n'
