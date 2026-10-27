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
# init_workspace.sh - 初始化工作空间
#
# 一次性完成：校验配置、选择模型、创建日志目录
# 输出一份 .iter-state.env 供后续脚本和 agent 读取
#
# 用法:
#   bash init_workspace.sh [--config iter-config.yaml] [--model "模型名"]
#
# 输出文件 .iter-state.env 内容示例:
#   FRAMEWORK=opencode
#   SKILL_NAME=openeuler-docker-fault
#   SKILL_PATH=/path/to/skill/SKILL.md
#   MAX_ROUNDS=5
#   OPTIMIZATION_GOAL=准确率达到 90% 以上
#   TASK_EXECUTE=我的 docker 应用卡顿...
#   TASK_OPTIMIZE=请使用 skill-optimizer...
#   TASK_SYNC=请使用 skill-sync...
#   MODEL=qwen-max-latest
#   WORK_DIR=./iteration-logs
#   CURRENT_ROUND=0
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="./iter-config.yaml"
MODEL_ARG=""
WORK_DIR="./iteration-logs"

while [[ $# -gt 0 ]]; do
    case $1 in
        --config) CONFIG_FILE="$2"; shift 2 ;;
        --model) MODEL_ARG="$2"; shift 2 ;;
        --work-dir) WORK_DIR="$2"; shift 2 ;;
        -h|--help)
            echo "用法: bash init_workspace.sh [--config <yaml>] [--model <模型名>] [--work-dir <目录>]"
            exit 0
            ;;
        *) echo "未知参数: $1"; exit 1 ;;
    esac
done

# ============================================================================
# 校验配置文件
# ============================================================================

if [[ ! -f "$CONFIG_FILE" ]]; then
    echo "错误: 配置文件不存在: $CONFIG_FILE"
    echo "请在当前目录下创建 iter-config.yaml"
    exit 1
fi

echo "解析配置文件: $CONFIG_FILE"
python3 "$SCRIPT_DIR/parse_config.py" "$CONFIG_FILE"

# 提取各字段
FRAMEWORK=$(python3 "$SCRIPT_DIR/parse_config.py" "$CONFIG_FILE" --get framework)
SKILL_NAME=$(python3 "$SCRIPT_DIR/parse_config.py" "$CONFIG_FILE" --get skill.name)
SKILL_PATH=$(python3 "$SCRIPT_DIR/parse_config.py" "$CONFIG_FILE" --get skill.path)
MAX_ROUNDS=$(python3 "$SCRIPT_DIR/parse_config.py" "$CONFIG_FILE" --get optimization.max_rounds)
SCORE_THRESHOLD=$(python3 "$SCRIPT_DIR/parse_config.py" "$CONFIG_FILE" --get optimization.score_threshold)
OPTIMIZATION_GOAL=$(python3 "$SCRIPT_DIR/parse_config.py" "$CONFIG_FILE" --get optimization.goal 2>/dev/null || echo "")
TASK_EXECUTE=$(python3 "$SCRIPT_DIR/parse_config.py" "$CONFIG_FILE" --get tasks.query)
TASK_OPTIMIZE=$(python3 "$SCRIPT_DIR/parse_config.py" "$CONFIG_FILE" --get tasks.optimize)
TASK_SYNC=$(python3 "$SCRIPT_DIR/parse_config.py" "$CONFIG_FILE" --get tasks.sync)

# 校验关键字段
errors=()
[[ -z "$SKILL_NAME" ]] && errors+=("skill.name 未配置")
[[ -z "$SKILL_PATH" ]] && errors+=("skill.path 未配置")
[[ -z "$TASK_EXECUTE" ]] && errors+=("tasks.query 未配置")
[[ -z "$SCORE_THRESHOLD" ]] && errors+=("optimization.score_threshold 未配置")

if [[ ${#errors[@]} -gt 0 ]]; then
    echo "配置校验失败:"
    for err in "${errors[@]}"; do
        echo "  - $err"
    done
    exit 1
fi

# ============================================================================
# 模型（优先级：--model 参数 > 配置文件 model 字段 > 空）
# ============================================================================

CONFIG_MODEL=$(python3 "$SCRIPT_DIR/parse_config.py" "$CONFIG_FILE" --get model 2>/dev/null || echo "")

if [[ -n "$MODEL_ARG" ]]; then
    MODEL="$MODEL_ARG"
    echo "使用指定模型: $MODEL"
elif [[ -n "$CONFIG_MODEL" && "$CONFIG_MODEL" != "None" ]]; then
    MODEL="$CONFIG_MODEL"
    echo "使用配置文件中的模型: $MODEL"
else
    MODEL=""
    echo "未指定模型，将使用 opencode 默认模型"
fi

# ============================================================================
# 创建日志目录
# ============================================================================

mkdir -p "$WORK_DIR"

# ============================================================================
# 写入状态文件
# ============================================================================

STATE_FILE="./.iter-state.env"

cat > "$STATE_FILE" <<ENVEOF
FRAMEWORK=${FRAMEWORK}
SKILL_NAME=${SKILL_NAME}
SKILL_PATH=${SKILL_PATH}
MAX_ROUNDS=${MAX_ROUNDS}
SCORE_THRESHOLD=${SCORE_THRESHOLD}
OPTIMIZATION_GOAL=${OPTIMIZATION_GOAL}
TASK_EXECUTE=${TASK_EXECUTE}
TASK_OPTIMIZE=${TASK_OPTIMIZE}
TASK_SYNC=${TASK_SYNC}
MODEL=${MODEL}
WORK_DIR=${WORK_DIR}
CURRENT_ROUND=0
ENVEOF

echo ""
echo "=========================================="
echo "工作空间初始化完成"
echo "=========================================="
echo "状态文件: $STATE_FILE"
echo "模型:     ${MODEL:-默认}"
echo "日志目录: $WORK_DIR"
echo "=========================================="
