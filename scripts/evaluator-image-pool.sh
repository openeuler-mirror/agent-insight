#!/usr/bin/env bash

evaluator_image_pool_mounts() {
  POOL_ENABLED=true
  POOL_MAC_DISK_PATH=
  POOL_MODE=linux
  POOL_CONTAINERD=false
  if [ "${#EVALUATOR_ENV[@]}" -gt 0 ]; then
    for evaluator_env in "${EVALUATOR_ENV[@]}"; do
      case "$evaluator_env" in
        IMAGE_POOL_ENABLED=*) POOL_ENABLED=${evaluator_env#*=}; POOL_ENABLED=${POOL_ENABLED:-true} ;;
        IMAGE_POOL_MAC_DISK_PATH=*) POOL_MAC_DISK_PATH=${evaluator_env#*=} ;;
        IMAGE_POOL_DISK_MODE=*|IMAGE_POOL_DISK_PATH=*|IMAGE_POOL_HOST_DISK_PATH=*|IMAGE_POOL_CONTAINERD_PATH=*)
          fail '镜像池内部磁盘配置由启动脚本检测，不接受 --evaluator-env 覆盖' ;;
      esac
    done
  fi
  case "$POOL_ENABLED" in true|false) ;; *) fail 'IMAGE_POOL_ENABLED 必须为 true 或 false' ;; esac
  POOL_ARGS=(--label "agent-insight.image-pool=$POOL_ENABLED")
  [ "$POOL_ENABLED" = true ] || return 0
  POOL_DOCKER_ROOT=$(docker info --format '{{.DockerRootDir}}')
  case "$POOL_DOCKER_ROOT" in /*) ;; *) fail '无法确定 Docker 数据目录' ;; esac
  case "$POOL_DOCKER_ROOT" in *','*|*$'\n'*) fail 'Docker 数据目录包含不支持的字符' ;; esac
  POOL_ARGS+=(--mount "type=bind,src=$POOL_DOCKER_ROOT,dst=/host-docker,readonly")
  if [ "$HOST_OS" = linux ]; then
    [ -d "$POOL_DOCKER_ROOT" ] || fail 'Docker 数据目录不可见，请使用本机 Linux daemon'
    return 0
  fi
  [ "$HOST_OS" = darwin ] && [ "$(docker info --format '{{.OperatingSystem}}')" = 'Docker Desktop' ] \
    || fail 'Mac 镜像池只支持本机 Docker Desktop，不支持其他虚拟机或远程 daemon'
  POOL_MODE=desktop-mac
  case "$(docker info --format '{{json .DriverStatus}}')" in
    *snapshotter*)
      POOL_CONTAINERD=true
      POOL_ARGS+=(--mount 'type=bind,src=/var/lib/desktop-containerd,dst=/host-containerd,readonly') ;;
  esac

  local settings_file
  settings_file="$HOME/Library/Group Containers/group.com.docker/settings-store.json"
  [ -f "$settings_file" ] || settings_file="$HOME/Library/Group Containers/group.com.docker/settings.json"
  evaluator_image_pool_mac_path "$settings_file"
  POOL_ARGS+=(--mount "type=bind,src=$POOL_MAC_DISK_PATH,dst=/host-mac-space,readonly")
}

evaluator_image_pool_mac_path() {
  local settings_file=$1 data_folder disk_image host_device image_device
  [ -f "$settings_file" ] || fail '未找到本机 Docker Desktop 配置，无法核实磁盘映像位置'
  /usr/bin/plutil -convert xml1 -o - "$settings_file" >/dev/null || fail '无法解析 Docker Desktop 配置'
  if data_folder=$(/usr/bin/plutil -extract DataFolder raw -o - "$settings_file" 2>/dev/null); then
    :
  elif data_folder=$(/usr/bin/plutil -extract dataFolder raw -o - "$settings_file" 2>/dev/null); then
    :
  else
    data_folder=
  fi
  data_folder=${data_folder:-$HOME/Library/Containers/com.docker.docker/Data/vms/0/data}
  disk_image="$data_folder/Docker.raw"
  [ -f "$disk_image" ] || fail '无法核实 Docker Desktop 的 Docker.raw 位置；请检查 Disk image location，暂不支持其他磁盘布局'
  if [ -z "$POOL_MAC_DISK_PATH" ]; then
    POOL_MAC_DISK_PATH="$EVALUATOR_MANAGEMENT_HOME/space-probe"
    mkdir -p "$POOL_MAC_DISK_PATH"
  fi
  [ -d "$POOL_MAC_DISK_PATH" ] || fail 'IMAGE_POOL_MAC_DISK_PATH 必须是已存在的 Docker 可共享目录'
  POOL_MAC_DISK_PATH=$(CDPATH= cd -- "$POOL_MAC_DISK_PATH" && pwd -P)
  case "$POOL_MAC_DISK_PATH" in *','*|*$'\n'*) fail 'IMAGE_POOL_MAC_DISK_PATH 包含不支持的字符' ;; esac
  host_device=$(stat -L -f '%d' "$POOL_MAC_DISK_PATH") || fail '无法读取 Mac 探测目录的文件系统'
  image_device=$(stat -L -f '%d' "$disk_image") || fail '无法读取 Docker.raw 的文件系统'
  [ "$host_device" = "$image_device" ] || fail 'Mac 探测目录与 Docker.raw 不在同一文件系统；请通过 --evaluator-env IMAGE_POOL_MAC_DISK_PATH=目录 指定同盘的空共享目录'
}

evaluator_image_pool_env() {
  printf 'IMAGE_POOL_ENABLED=%s\n' "$POOL_ENABLED"
  [ "$POOL_ENABLED" = true ] || return 0
  printf 'IMAGE_POOL_DISK_MODE=%s\nIMAGE_POOL_DISK_PATH=/host-docker\n' "$POOL_MODE"
  if [ "$POOL_MODE" = desktop-mac ]; then
    printf 'IMAGE_POOL_HOST_DISK_PATH=/host-mac-space\n'
    [ "$POOL_CONTAINERD" = false ] || printf 'IMAGE_POOL_CONTAINERD_PATH=/host-containerd\n'
  fi
}
