#!/usr/bin/env bash
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
