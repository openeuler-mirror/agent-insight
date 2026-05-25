#!/usr/bin/env bash
set -euo pipefail

NEW_SKILL_DIR=""
OLD_SKILL_DIR=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --new) NEW_SKILL_DIR="$2"; shift 2 ;;
        --old) OLD_SKILL_DIR="$2"; shift 2 ;;
        -h|--help)
            echo "Usage: $0 --new <optimized-skill-dir> --old <old-skill-dir>"
            echo ""
            echo "  --new   Absolute path to the optimized skill directory (the inner skill dir)"
            echo "  --old   Absolute path to the old skill directory to be replaced"
            echo ""
            echo "This script:"
            echo "  1. Archives the old skill to ~/.skill-insight/skill-history/ with timestamp suffix"
            echo "  2. Copies the optimized skill to the old skill's location"
            exit 0
            ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

if [ -z "$NEW_SKILL_DIR" ] || [ -z "$OLD_SKILL_DIR" ]; then
    echo "❌ Error: Both --new and --old are required."
    echo "Usage: $0 --new <optimized-skill-dir> --old <old-skill-dir>"
    exit 1
fi

if [ ! -d "$NEW_SKILL_DIR" ]; then
    echo "❌ Error: New skill directory does not exist: $NEW_SKILL_DIR"
    exit 1
fi

if [ ! -f "$NEW_SKILL_DIR/SKILL.md" ]; then
    echo "❌ Error: No SKILL.md found in: $NEW_SKILL_DIR"
    exit 1
fi

if [ ! -d "$OLD_SKILL_DIR" ]; then
    echo "❌ Error: Old skill directory does not exist: $OLD_SKILL_DIR"
    exit 1
fi

HISTORY_DIR="$HOME/.skill-insight/skill-history"
mkdir -p "$HISTORY_DIR"

SKILL_NAME=$(basename "$OLD_SKILL_DIR")
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
ARCHIVE_DIR="${HISTORY_DIR}/${SKILL_NAME}-${TIMESTAMP}"

if [ -d "$ARCHIVE_DIR" ]; then
    IDX=1
    while [ -d "${ARCHIVE_DIR}-${IDX}" ]; do IDX=$((IDX+1)); done
    ARCHIVE_DIR="${ARCHIVE_DIR}-${IDX}"
fi

mv "$OLD_SKILL_DIR" "$ARCHIVE_DIR"
echo "📦 旧版 Skill 已归档至: $ARCHIVE_DIR"

cp -r "$NEW_SKILL_DIR" "$OLD_SKILL_DIR"
echo "✅ 优化后的 Skill 已加载至: $OLD_SKILL_DIR"
echo "👉 请重启 opencode 以使新 Skill 生效。"
