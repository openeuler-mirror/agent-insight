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
# snapshot_skill.sh - 备份当前版本 skill 到日志目录
#
# 每轮优化前调用，将当前 skill 目录完整备份到 round-N/skill-snapshot/
# 确保历史版本可追溯。
#
# 用法:
#   bash snapshot_skill.sh --skill-path /path/to/skill/SKILL.md --round-dir ./iteration-logs/round-1
#
# 输出:
#   备份路径输出到 stdout (如 ./iteration-logs/round-1/skill-snapshot/SKILL.md)
# ============================================================================

set -euo pipefail

SKILL_PATH=""
ROUND_DIR=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --skill-path) SKILL_PATH="$2"; shift 2 ;;
        --round-dir) ROUND_DIR="$2"; shift 2 ;;
        *) echo "未知参数: $1"; exit 1 ;;
    esac
done

if [[ -z "$SKILL_PATH" || -z "$ROUND_DIR" ]]; then
    echo "[snapshot_skill] 错误: 缺少参数。用法: bash snapshot_skill.sh --skill-path <路径> --round-dir <轮次目录>"
    exit 1
fi

# skill 可能是单个文件 (SKILL.md) 或整个目录
# 统一按目录处理：如果传入的是文件路径，取其所在目录
if [[ -f "$SKILL_PATH" ]]; then
    SKILL_DIR="$(dirname "$SKILL_PATH")"
    SKILL_FILENAME="$(basename "$SKILL_PATH")"
elif [[ -d "$SKILL_PATH" ]]; then
    SKILL_DIR="$SKILL_PATH"
    SKILL_FILENAME=""
else
    echo "[snapshot_skill] 错误: skill 路径不存在: $SKILL_PATH"
    exit 1
fi

SNAPSHOT_DIR="$ROUND_DIR/skill-snapshot"
mkdir -p "$SNAPSHOT_DIR"

# 复制整个 skill 目录内容到 snapshot
cp -r "$SKILL_DIR"/* "$SNAPSHOT_DIR/" 2>/dev/null || true
# 确保 SKILL.md 本身也被复制（如果 skill_dir 是父目录的情况）
if [[ -n "$SKILL_FILENAME" && -f "$SKILL_PATH" ]]; then
    cp "$SKILL_PATH" "$SNAPSHOT_DIR/$SKILL_FILENAME" 2>/dev/null || true
fi

# 输出 snapshot 中 SKILL.md 的路径（如果存在）
if [[ -n "$SKILL_FILENAME" && -f "$SNAPSHOT_DIR/$SKILL_FILENAME" ]]; then
    echo "$SNAPSHOT_DIR/$SKILL_FILENAME"
elif [[ -f "$SNAPSHOT_DIR/SKILL.md" ]]; then
    echo "$SNAPSHOT_DIR/SKILL.md"
else
    # 找不到 SKILL.md，输出 snapshot 目录本身
    echo "$SNAPSHOT_DIR"
fi
