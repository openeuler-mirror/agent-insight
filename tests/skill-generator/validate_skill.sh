#!/usr/bin/env bash
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

# validate_skill.sh (tests wrapper)
#
# 真正的验证逻辑在 skills/skill-generator/scripts/validate_skill.sh
# 本文件只是一个透传包装，确保两处调用行为一致。
#
# 用法: ./validate_skill.sh <skill_dir>

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CANONICAL="$SCRIPT_DIR/../../skills/skill-generator/scripts/validate_skill.sh"

if [[ ! -f "$CANONICAL" ]]; then
    echo "❌ 找不到验证脚本: $CANONICAL"
    exit 1
fi

exec bash "$CANONICAL" "$@"
