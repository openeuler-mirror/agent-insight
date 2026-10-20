#!/bin/sh
set -eu

case "${1:-opencode}" in
    -h|--help)
        printf '%s\n' '用法：sh ~/.agent-insight/model-proxy.sh [opencode|qoder|opencode,qoder] [Qoder 配置参数]'
        printf '%s\n' '在 Agent 项目目录运行；先备份，再启用或同步模型转发。底层需要 Node.js 20 或更高版本。'
        exit 0
        ;;
    opencode|qoder|opencode,qoder|qoder,opencode) ;;
    *)
        printf '%s\n' '请选择 opencode、qoder 或 opencode,qoder；使用 --help 查看帮助。' >&2
        exit 2
        ;;
esac

proxy_script_dir=${0%/*}
if [ "$proxy_script_dir" = "$0" ]; then proxy_script_dir=.; fi
proxy_script_dir=$(CDPATH= cd "$proxy_script_dir" && pwd -P)
proxy_home=${AGENT_INSIGHT_HOME:-$proxy_script_dir}
proxy_runtime="$proxy_home/inference-runtime"
if [ ! -f "$proxy_runtime/inference_proxy.mjs" ]; then
    printf '%s\n' '未找到模型转发组件，请先重新执行平台提供的采集安装命令。尚未修改模型配置。' >&2
    exit 1
fi

proxy_node=
if [ -r "$proxy_runtime/node-path" ]; then
    IFS= read -r proxy_node < "$proxy_runtime/node-path" || proxy_node=
fi
proxy_node_available() {
    [ -n "$1" ] && [ -x "$1" ] &&
        "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' >/dev/null 2>&1
}
if ! proxy_node_available "$proxy_node"; then
    proxy_node=$(command -v node || :)
fi
if ! proxy_node_available "$proxy_node"; then
    printf '%s\n' '需要 Node.js 20 或更高版本。安装时的 Node 已不可用，当前 PATH 也未找到兼容版本。请恢复 Node 后重试；尚未修改模型配置。' >&2
    exit 1
fi

if [ "$#" -eq 0 ]; then set -- opencode; fi
proxy_agents=$1
shift
exec "$proxy_node" "$proxy_runtime/inference_proxy.mjs" configure "$proxy_home" "$proxy_agents" "$@"
