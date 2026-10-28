#!/bin/bash
# Copyright (c) 2026 Huawei Technologies Co., Ltd.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# ============================================================================
# fault_inject.sh - 执行故障注入或故障清理命令
#
# 用法:
#   bash fault_inject.sh --config iter-config.yaml --action inject
#   bash fault_inject.sh --config iter-config.yaml --action cleanup
#
# 退出码:
#   0 = 执行成功（或无需执行：未配置故障注入）
#   1 = 执行失败
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="./iter-config.yaml"
ACTION=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --config) CONFIG_FILE="$2"; shift 2 ;;
        --action) ACTION="$2"; shift 2 ;;
        *) echo "未知参数: $1"; exit 1 ;;
    esac
done

if [[ -z "$ACTION" ]]; then
    echo "错误: 缺少 --action 参数 (inject 或 cleanup)"
    exit 1
fi

if [[ "$ACTION" != "inject" && "$ACTION" != "cleanup" ]]; then
    echo "错误: --action 必须是 inject 或 cleanup"
    exit 1
fi

if [[ ! -f "$CONFIG_FILE" ]]; then
    echo "错误: 配置文件不存在: $CONFIG_FILE"
    exit 1
fi

# 提取命令
CMD=$(python3 "$SCRIPT_DIR/parse_config.py" "$CONFIG_FILE" --get "fault_injection.${ACTION}" 2>/dev/null || echo "")

if [[ -z "$CMD" ]]; then
    echo "[fault_inject] 未配置 fault_injection.${ACTION}，跳过"
    exit 0
fi

echo "[fault_inject] 执行 ${ACTION} 命令: ${CMD}"
eval "$CMD"
EXIT_CODE=$?

if [[ $EXIT_CODE -eq 0 ]]; then
    echo "[fault_inject] ${ACTION} 执行成功"
else
    echo "[fault_inject] ${ACTION} 执行失败 (退出码: ${EXIT_CODE})"
fi

exit $EXIT_CODE
