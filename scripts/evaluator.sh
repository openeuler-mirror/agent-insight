#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPOSITORY_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
CONTAINER_NAME=agent-insight-benchmark-evaluator
DATA_VOLUME=agent-insight-benchmark-evaluator-data
BIND_ADDRESS=0.0.0.0
EVALUATOR_HOST_PORT=""
PLATFORM_BASE_URL=${EVALUATOR_AGENT_INSIGHT_BASE_URL:-}
EVALUATOR_ENV=()
source "$SCRIPT_DIR/evaluator-management.sh"
source "$SCRIPT_DIR/evaluator-image-pool.sh"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/evaluator.sh start [--evaluator-env NAME=VALUE] [--platform-base-url URL] [--bind-address ADDRESS] [--port PORT]
  bash scripts/evaluator.sh status
  bash scripts/evaluator.sh stop [--purge-images] [--dry-run]
  bash scripts/evaluator.sh images list
  bash scripts/evaluator.sh images purge [--dry-run]

The start command builds and starts the Evaluator Controller from the current Git
checkout on Linux or macOS. The stop command stops it immediately. Image commands
keep the Controller running and operate only on the shared Benchmark image pool.
Defaults: --bind-address 0.0.0.0 --port 3001.
Port precedence: --port > AGENT_INSIGHT_EVALUATOR_PORT in process environment
> $AGENT_INSIGHT_HOME/.env (default: $HOME/.agent-insight/.env) > 3001.
The container always listens on 8080. Legacy PORT is not supported.
The command always builds the generic Controller image. Benchmark runtimes are resolved
from the generated Catalog only when an evaluation task requires them.
It does not pull source code, register with Agent Insight, or preload Benchmark runtimes.
EOF
}

fail() {
  printf 'Evaluator 管理失败：%s\n' "$1" >&2
  exit 1
}

git_checkout() {
  git -c "safe.directory=$REPOSITORY_ROOT" -C "$REPOSITORY_ROOT" "$@"
}

prepare_management() {
  command -v docker >/dev/null 2>&1 || fail '宿主缺少命令：docker'
  docker info >/dev/null || fail 'Docker daemon 不可用'
  local docker_context socket_url
  docker_context=$(docker context show)
  socket_url=${DOCKER_HOST:-$(docker context inspect "$docker_context" --format '{{.Endpoints.docker.Host}}')}
  case "$socket_url" in
    unix:///*) DOCKER_SOCKET=${socket_url#unix://} ;;
    *) fail '仅支持当前主机 Unix Docker socket，不自动操作远端主机' ;;
  esac
  EVALUATOR_MANAGEMENT_HOME=${AGENT_INSIGHT_EVALUATOR_HOME:-$HOME/.agent-insight/evaluator}
  CONFIG_FILE=$EVALUATOR_MANAGEMENT_HOME/evaluator.env
  MANAGEMENT_IMAGE=$(docker container inspect "$CONTAINER_NAME" --format '{{.Image}}' 2>/dev/null || true)
  if [ -z "$MANAGEMENT_IMAGE" ] && [ -f "$CONFIG_FILE" ]; then
    MANAGEMENT_IMAGE=$(awk -F= '$1 == "EVALUATOR_CONTROLLER_IMAGE_ID" { print $2 }' "$CONFIG_FILE" | tail -1)
  fi
  DATA_VOLUME_PRESENT=false
  if docker volume inspect "$DATA_VOLUME" >/dev/null 2>&1; then DATA_VOLUME_PRESENT=true; fi
}

stop_evaluator() {
  local purge=false dry_run=false argument management_output result marker expected_id reference actual_id daemon_id
  for argument in "$@"; do
    case "$argument" in
      --purge-images) purge=true ;;
      --dry-run) dry_run=true ;;
      --help|-h) usage; return 0 ;;
      *) fail "stop 不支持的参数：$argument" ;;
    esac
  done
  [ "$dry_run" = false ] || [ "$purge" = true ] || fail 'stop --dry-run 必须与 --purge-images 一起使用'
  prepare_management
  daemon_id=$(docker info --format '{{.ID}}')
  if [ "$DATA_VOLUME_PRESENT" = false ]; then
    if [ -z "$MANAGEMENT_IMAGE" ]; then printf '未发现评测服务部署，无需停止。\n'; return 0; fi
    fail '缺少登记数据卷，拒绝猜测资源归属'
  fi
  if [ -z "$MANAGEMENT_IMAGE" ] || ! docker image inspect "$MANAGEMENT_IMAGE" >/dev/null 2>&1; then
    if [ -f "$EVALUATOR_MANAGEMENT_HOME/purge-completed" ] \
      && [ "$(head -1 "$EVALUATOR_MANAGEMENT_HOME/purge-completed")" = "$daemon_id|$MANAGEMENT_IMAGE" ] \
      && [ -z "$(docker ps -aq --filter "label=agent-insight.evaluator-instance=$CONTAINER_NAME")" ] \
      && ! docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
      printf '服务已停止；上次镜像清理已完成。数据卷和配置保留。\n'
      return 0
    fi
    fail '缺少离线管理运行镜像，无法核对数据卷；请先使用 evaluator.sh start 恢复管理环境'
  fi
  MANAGEMENT_ARGS=()
  [ "$purge" = false ] || MANAGEMENT_ARGS+=(--purge-images)
  if [ "$dry_run" = true ]; then
    MANAGEMENT_READONLY=,readonly
    MANAGEMENT_ARGS+=(--dry-run)
    evaluator_management_run "$MANAGEMENT_IMAGE" "${MANAGEMENT_ARGS[@]}"
    return
  fi
  evaluator_management_lock || fail '管理操作冲突'
  management_output=$(mktemp "${TMPDIR:-/tmp}/evaluator-stop.XXXXXX")
  trap 'rm -f "${management_output:-}"; rmdir "$EVALUATOR_MANAGEMENT_LOCK" 2>/dev/null || true' EXIT
  result=0
  if [ "${#MANAGEMENT_ARGS[@]}" -gt 0 ]; then
    evaluator_management_run "$MANAGEMENT_IMAGE" "${MANAGEMENT_ARGS[@]}" > "$management_output" || result=$?
  else
    evaluator_management_run "$MANAGEMENT_IMAGE" > "$management_output" || result=$?
  fi
  cat "$management_output"
  if [ "$purge" = true ]; then
    while IFS=$'\t' read -r marker expected_id reference; do
      [ "$marker" = CONTROLLER_IMAGE ] || continue
      actual_id=$(docker image inspect "$reference" --format '{{.Id}}' 2>/dev/null || true)
      [ -n "$actual_id" ] || continue
      if [ "$actual_id" != "$expected_id" ]; then
        printf '跳过已变更的 Controller 引用：%s\n' "$reference" >&2
        result=2
      elif ! docker image rm "$reference"; then result=2
      fi
    done < "$management_output"
  fi
  if [ "$purge" = true ] && [ "$result" -eq 0 ]; then
    printf '%s|%s\n' "$daemon_id" "$MANAGEMENT_IMAGE" > "$EVALUATOR_MANAGEMENT_HOME/purge-completed"
  fi
  exit "$result"
}

images_evaluator() {
  local action=${1:-} dry_run=false argument
  [ -n "$action" ] || fail 'images 需要 list 或 purge 子命令'
  shift || true
  case "$action" in
    list)
      [ "$#" -eq 0 ] || fail 'images list 不接受其他参数' ;;
    purge)
      for argument in "$@"; do
        case "$argument" in --dry-run) dry_run=true ;; *) fail "images purge 不支持的参数：$argument" ;; esac
      done ;;
    *) fail 'images 需要 list 或 purge 子命令' ;;
  esac
  prepare_management
  [ "$DATA_VOLUME_PRESENT" = true ] || fail '缺少评测服务登记数据卷'
  [ -n "$MANAGEMENT_IMAGE" ] && docker image inspect "$MANAGEMENT_IMAGE" >/dev/null 2>&1 \
    || fail '缺少包含管理工具的 Controller 镜像'
  MANAGEMENT_READONLY=,readonly
  if [ "$action" = list ]; then
    evaluator_management_run "$MANAGEMENT_IMAGE" --images-list
    return
  fi
  if [ "$dry_run" = true ]; then
    evaluator_management_run "$MANAGEMENT_IMAGE" --images-purge --dry-run
    return
  fi
  evaluator_management_lock || fail '管理操作冲突'
  evaluator_management_run "$MANAGEMENT_IMAGE" --images-purge
}

status_evaluator() {
  [ "$#" -eq 0 ] || fail 'status 不接受参数'
  command -v docker >/dev/null 2>&1 || fail '宿主缺少命令：docker'
  local inspect_error
  if ! inspect_error=$(docker container inspect "$CONTAINER_NAME" 2>&1 >/dev/null); then
    if printf '%s' "$inspect_error" | LC_ALL=C grep -Eqi 'no such (container|object)'; then
      printf 'deployed: false\nrunning: false\n'
      return 3
    fi
    fail "无法检查 Controller：$inspect_error"
  fi
  local running image ports health
  running=$(docker container inspect "$CONTAINER_NAME" --format '{{.State.Running}}')
  image=$(docker container inspect "$CONTAINER_NAME" --format '{{.Image}}')
  ports=$(docker container port "$CONTAINER_NAME" 8080/tcp 2>/dev/null || true)
  health=null
  if [ "$running" = true ]; then
    health=$(docker exec "$CONTAINER_NAME" node -e 'fetch("http://127.0.0.1:8080/health").then(async r=>{const b=await r.text();if(!r.ok)process.exitCode=1;process.stdout.write(b)}).catch(e=>{console.error(e.message);process.exitCode=1})' 2>/dev/null || printf 'null')
  fi
  printf 'deployed: true\nrunning: %s\nimage: %s\nports: %s\nhealth: %s\n' \
    "$running" "$image" "${ports:-none}" "$health"
  [ "$running" = true ]
}

[ "$#" -gt 0 ] || { usage; exit 1; }
COMMAND=$1
shift
case "$COMMAND" in
  start) ;;
  status) status_evaluator "$@"; exit $? ;;
  stop) stop_evaluator "$@"; exit $? ;;
  images) images_evaluator "$@"; exit $? ;;
  --help|-h|help) usage; exit 0 ;;
  *) fail "不支持的命令：$COMMAND" ;;
esac

while [ "$#" -gt 0 ]; do
  case "$1" in
    --platform-base-url|--bind-address|--port|--evaluator-env)
      [ "$#" -ge 2 ] || fail "$1 缺少参数值"
      case "$1" in
        --platform-base-url) PLATFORM_BASE_URL=$2 ;;
        --bind-address) BIND_ADDRESS=$2 ;;
        --port)
          [ -z "$EVALUATOR_HOST_PORT" ] || fail '--port 只能指定一次'
          [ -n "$2" ] || fail '--port 缺少参数值'
          EVALUATOR_HOST_PORT=$2 ;;
        --evaluator-env) EVALUATOR_ENV+=("$2") ;;
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

if [ -n "${PORT:-}" ]; then
  fail 'PORT 已移除；平台使用 AGENT_INSIGHT_PORT，评测服务使用 AGENT_INSIGHT_EVALUATOR_PORT'
fi
PORT_CONFIG_HOME=${AGENT_INSIGHT_HOME:-$HOME/.agent-insight}
case "$PORT_CONFIG_HOME" in
  '~'|'$HOME'|'${HOME}') PORT_CONFIG_HOME="$HOME" ;;
  '~/'*) PORT_CONFIG_HOME="$HOME/${PORT_CONFIG_HOME#\~/}" ;;
  '$HOME/'*) PORT_CONFIG_HOME="$HOME/${PORT_CONFIG_HOME#\$HOME/}" ;;
  '${HOME}/'*) PORT_CONFIG_HOME="$HOME/${PORT_CONFIG_HOME#\$\{HOME\}/}" ;;
esac
FILE_EVALUATOR_PORT=""
if [ -f "$PORT_CONFIG_HOME/.env" ]; then
  FILE_EVALUATOR_PORT=$(
    set +u
    . "$PORT_CONFIG_HOME/.env" >/dev/null || exit 1
    [ -z "${PORT:-}" ] || { printf 'PORT 已移除，请先将 .env 中的 PORT 改名为 AGENT_INSIGHT_PORT\n' >&2; exit 1; }
    printf '%s' "${AGENT_INSIGHT_EVALUATOR_PORT:-}"
  ) || fail '无法读取端口配置'
fi
if [ "${AGENT_INSIGHT_EVALUATOR_PORT+x}" = x ]; then
  FILE_EVALUATOR_PORT=$AGENT_INSIGHT_EVALUATOR_PORT
fi
EVALUATOR_HOST_PORT=${EVALUATOR_HOST_PORT:-${FILE_EVALUATOR_PORT:-3001}}
case "$EVALUATOR_HOST_PORT" in
  ''|*[!0-9]*) fail 'AGENT_INSIGHT_EVALUATOR_PORT / --port 必须是 1～65535 的整数' ;;
esac
[ "${#EVALUATOR_HOST_PORT}" -le 5 ] && [ "$EVALUATOR_HOST_PORT" -ge 1 ] && [ "$EVALUATOR_HOST_PORT" -le 65535 ] || fail 'AGENT_INSIGHT_EVALUATOR_PORT / --port 必须是 1～65535 的整数'
if ! printf '%s' "$BIND_ADDRESS" | LC_ALL=C grep -Eq '^[A-Za-z0-9.:-]+$'; then
  fail '--bind-address 包含不支持的字符'
fi
case "$PLATFORM_BASE_URL" in
  '') ;;
  http://*|https://*)
    if printf '%s' "$PLATFORM_BASE_URL" | LC_ALL=C grep -q '[[:space:]]'; then
      fail '--platform-base-url 不能包含空白字符'
    fi
    PLATFORM_BASE_URL=${PLATFORM_BASE_URL%/}
    ;;
  *) fail '--platform-base-url 必须是 HTTP(S) URL' ;;
esac
if [ "${#EVALUATOR_ENV[@]}" -gt 0 ]; then
  for evaluator_env in "${EVALUATOR_ENV[@]}"; do
    printf '%s' "$evaluator_env" | LC_ALL=C grep -Eq '^[A-Za-z_][A-Za-z0-9_]*=.*$' \
      || fail '--evaluator-env 必须是 NAME=VALUE'
    case "$evaluator_env" in
      PORT=*|EVALUATOR_PORT=*|AGENT_INSIGHT_PORT=*|AGENT_INSIGHT_EVALUATOR_PORT=*)
        fail '端口不能通过 --evaluator-env 设置；请使用 --port 或 AGENT_INSIGHT_EVALUATOR_PORT' ;;
    esac
  done
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
evaluator_management_lock || fail '管理操作冲突'
rm -f "$EVALUATOR_MANAGEMENT_HOME/purge-completed"
ACTIVE_DOCKER_CONTEXT=$(docker context show 2>/dev/null || true)
if [ -n "${DOCKER_CONTEXT:-}" ] || [ -z "${DOCKER_HOST:-}" ]; then
  SOCKET_URL=$(docker context inspect "$ACTIVE_DOCKER_CONTEXT" --format '{{.Endpoints.docker.Host}}' 2>/dev/null || true)
else
  SOCKET_URL=$DOCKER_HOST
fi
if [ -z "$SOCKET_URL" ]; then SOCKET_URL=unix:///var/run/docker.sock; fi
case "$SOCKET_URL" in
  unix://*) DOCKER_SOCKET=${SOCKET_URL#unix://} ;;
  *) fail "当前 Docker context 使用远程 daemon，无法挂载 Socket：$SOCKET_URL" ;;
esac
[ -S "$DOCKER_SOCKET" ] || fail "Docker Socket 不存在或不是 Unix Socket：$DOCKER_SOCKET"

evaluator_image_pool_mounts

SHORT_REVISION=$(printf '%s' "$SOURCE_REVISION" | cut -c1-12)
DIRTY_SUFFIX=
if [ "$SOURCE_DIRTY" = true ]; then DIRTY_SUFFIX=-dirty; fi
IMAGE_REPOSITORY=agent-insight-benchmark-evaluator
IMAGE_TAG="$IMAGE_REPOSITORY:src-$SHORT_REVISION$DIRTY_SUFFIX"
EVALUATOR_DOCKERFILE="$REPOSITORY_ROOT/services/evaluator/Dockerfile"
PREVIOUS_CONTROLLER_IMAGE_IDS=$(docker image ls --quiet --no-trunc "$IMAGE_REPOSITORY")
if [ "$SOURCE_DIRTY" = true ] || ! docker image inspect "$IMAGE_TAG" >/dev/null 2>&1; then
  printf '构建 Evaluator Controller：%s\n' "$IMAGE_TAG"
  docker build \
    --file "$EVALUATOR_DOCKERFILE" \
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
trap 'rm -f "$TEMP_CONFIG"; rmdir "$EVALUATOR_MANAGEMENT_LOCK"' EXIT
{
  printf 'EVALUATOR_LISTEN_HOST=0.0.0.0\n'
  printf 'EVALUATOR_PORT=8080\n'
  printf 'EVALUATOR_DATA_DIR=/data\n'
  printf 'EVALUATOR_CONTROLLER_CONTAINER_ID=%s\n' "$CONTAINER_NAME"
  printf 'EVALUATOR_INSTANCE_ID=%s\n' "$CONTAINER_NAME"
  printf 'EVALUATOR_MAX_CONCURRENCY=%s\n' "${EVALUATOR_MAX_CONCURRENCY:-1}"
  printf 'EVALUATOR_AGENT_INSIGHT_BASE_URL=%s\n' "$PLATFORM_BASE_URL"
  if [ "${#EVALUATOR_ENV[@]}" -gt 0 ]; then
    runtime_env_names=
    for evaluator_env in "${EVALUATOR_ENV[@]}"; do printf '%s\n' "$evaluator_env"; done
    for evaluator_env in "${EVALUATOR_ENV[@]}"; do
      evaluator_env_name=${evaluator_env%%=*}
      case "$evaluator_env_name" in IMAGE_POOL_*) continue ;; esac
      if [ -n "$runtime_env_names" ]; then runtime_env_names="$runtime_env_names,$evaluator_env_name"
      else runtime_env_names=$evaluator_env_name
      fi
    done
    printf 'EVALUATOR_RUNTIME_ENV_NAMES=%s\n' "$runtime_env_names"
  fi
  evaluator_image_pool_env
  printf 'EVALUATOR_HOST_OS=%s\n' "$HOST_OS"
  printf 'EVALUATOR_HOST_ARCH=%s\n' "$HOST_ARCH"
  printf 'EVALUATOR_SOURCE_REVISION=%s\n' "$SOURCE_REVISION"
  printf 'EVALUATOR_SOURCE_DIRTY=%s\n' "$SOURCE_DIRTY"
  printf 'EVALUATOR_CONTROLLER_IMAGE_ID=%s\n' "$IMAGE_ID"
} > "$TEMP_CONFIG"
chmod 600 "$TEMP_CONFIG"

if [ "$POOL_ENABLED" = true ]; then
  docker run --rm --pull never --network none --read-only --entrypoint node \
    --env-file "$TEMP_CONFIG" --env EVALUATOR_CONTROLLER_CONTAINER_ID= \
    "${POOL_ARGS[@]}" --mount "type=bind,src=$DOCKER_SOCKET,dst=/var/run/docker.sock" \
    "$IMAGE_ID" -e 'const {imagePoolConfig}=require("/app/services/evaluator/src/image-pool.cjs"); imagePoolConfig(); const {DockerImageStore}=require("/app/services/evaluator/src/image-pool-docker.cjs"); const store=new DockerImageStore({checkManagers:false}); store.initialize().then(()=>console.log("镜像池磁盘预检通过", JSON.stringify(store.diskStatus))).catch(e=>{console.error(e.message);process.exitCode=1})' \
    || fail '镜像池磁盘预检失败，未停止旧服务；请检查挂载权限、存储布局与配置'
fi

mv -f "$TEMP_CONFIG" "$CONFIG_FILE"
chmod 600 "$CONFIG_FILE"
trap 'rmdir "$EVALUATOR_MANAGEMENT_LOCK"' EXIT
CONFIG_DIGEST=$(git_checkout hash-object --no-filters "$CONFIG_FILE")

docker volume create "$DATA_VOLUME" >/dev/null
if docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  evaluator_management_run "$IMAGE_ID"
fi
evaluator_management_run "$IMAGE_ID" --start
printf '启动 Evaluator Controller 容器：%s\n' "$CONTAINER_NAME"
docker run --detach --pull never \
  --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  --label "agent-insight.evaluator.config-digest=$CONFIG_DIGEST" \
  --add-host host.docker.internal:host-gateway \
  --env-file "$CONFIG_FILE" \
  "${POOL_ARGS[@]}" \
  --mount "type=bind,src=$DOCKER_SOCKET,dst=/var/run/docker.sock" \
  --mount "type=volume,src=$DATA_VOLUME,dst=/data" \
  --publish "$BIND_ADDRESS:$EVALUATOR_HOST_PORT:8080" \
  "$IMAGE_TAG" >/dev/null

bash "$SCRIPT_DIR/evaluator-doctor.sh" \
  --container "$CONTAINER_NAME" \
  --config "$CONFIG_FILE" \
  --expected-image-id "$IMAGE_ID"

while IFS='|' read -r CONTROLLER_REPOSITORY CONTROLLER_TAG; do
  [ "$CONTROLLER_REPOSITORY" = "$IMAGE_REPOSITORY" ] || continue
  [ "$CONTROLLER_TAG" != '<none>' ] || continue
  OLD_CONTROLLER_REF="$CONTROLLER_REPOSITORY:$CONTROLLER_TAG"
  [ "$OLD_CONTROLLER_REF" = "$IMAGE_TAG" ] && continue
  if docker image rm "$OLD_CONTROLLER_REF" >/dev/null 2>&1; then
    printf '已删除旧 Controller 镜像：%s\n' "$OLD_CONTROLLER_REF"
  else
    printf '警告：旧 Controller 镜像仍被其他容器引用，未删除：%s\n' "$OLD_CONTROLLER_REF" >&2
  fi
done < <(docker image ls --format '{{.Repository}}|{{.Tag}}' "$IMAGE_REPOSITORY")

while IFS= read -r PREVIOUS_CONTROLLER_IMAGE_ID; do
  [ -n "$PREVIOUS_CONTROLLER_IMAGE_ID" ] || continue
  [ "$PREVIOUS_CONTROLLER_IMAGE_ID" = "$IMAGE_ID" ] && continue
  docker image inspect "$PREVIOUS_CONTROLLER_IMAGE_ID" >/dev/null 2>&1 || continue
  if docker image rm "$PREVIOUS_CONTROLLER_IMAGE_ID" >/dev/null 2>&1; then
    printf '已删除旧 Controller image ID：%s\n' "$PREVIOUS_CONTROLLER_IMAGE_ID"
  else
    printf '警告：旧 Controller image ID 仍被其他容器或标签引用，未删除：%s\n' "$PREVIOUS_CONTROLLER_IMAGE_ID" >&2
  fi
done <<< "$PREVIOUS_CONTROLLER_IMAGE_IDS"

printf '\nEvaluator Controller 已就绪。\n'
printf 'Source revision: %s\n' "$SOURCE_REVISION"
printf 'Source dirty: %s\n' "$SOURCE_DIRTY"
printf 'Controller image ID: %s\n' "$IMAGE_ID"
if [ -n "$PLATFORM_BASE_URL" ]; then
  printf 'Agent Insight: %s\n' "$PLATFORM_BASE_URL"
else
  printf 'Agent Insight: 使用任务下发地址（兼容模式）\n'
fi
printf 'Listen: %s:%s\n' "$BIND_ADDRESS" "$EVALUATOR_HOST_PORT"
printf 'Data volume: %s\n' "$DATA_VOLUME"
printf 'Agent Insight 侧配置示例：\n'
printf '  AGENT_INSIGHT_BENCHMARK_EVALUATOR_BASE_URL=https://<evaluator-host>:%s\n' "$EVALUATOR_HOST_PORT"
printf '日志：docker logs -f %s\n' "$CONTAINER_NAME"
printf '重启：docker restart %s\n' "$CONTAINER_NAME"
printf 'Smoke：bash scripts/evaluator-doctor.sh --smoke <evaluator-key>\n'
