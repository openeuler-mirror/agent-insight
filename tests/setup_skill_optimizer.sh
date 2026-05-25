#!/bin/bash

# Setup script for skill-optimizer testing
# This script copies skill-optimizer to .opencode/skills directory

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
SKILL_SOURCE="$PROJECT_ROOT/skills/skill-optimizer"
SKILL_TARGET="$PROJECT_ROOT/.opencode/skills/skill-optimizer"
OVERWRITE_LOCAL=false

usage() {
    echo "Usage: $(basename "$0") [--overwrite-local]"
    echo ""
    echo "  --overwrite-local   Overwrite local files in target (.env and .opt/)."
    echo "                      Default: preserve existing .env and .opt/ if present."
}

for arg in "$@"; do
    case "$arg" in
        --overwrite-local)
            OVERWRITE_LOCAL=true
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "❌ Error: Unknown argument: $arg"
            echo ""
            usage
            exit 1
            ;;
    esac
done

echo "=========================================="
echo "  Skill Optimizer Setup Script"
echo "=========================================="
echo ""

# Check if source exists
if [ ! -d "$SKILL_SOURCE" ]; then
    echo "❌ Error: skill-optimizer source not found at:"
    echo "   $SKILL_SOURCE"
    exit 1
fi

if [ ! -f "$SKILL_SOURCE/SKILL.md" ]; then
    echo "❌ Error: SKILL.md not found in skill-optimizer"
    exit 1
fi

# Create target directory if not exists
mkdir -p "$PROJECT_ROOT/.opencode/skills"

if [ -d "$SKILL_TARGET" ]; then
    if [ "$OVERWRITE_LOCAL" = true ]; then
        echo "🔄 Removing existing skill-optimizer..."
        rm -rf "$SKILL_TARGET"
        echo "📦 Copying skill-optimizer to .opencode/skills/..."
        cp -r "$SKILL_SOURCE" "$SKILL_TARGET"
    else
        echo "�️ Preserving existing .env and .opt/ in target (use --overwrite-local to override)"
        TMP_DIR="$(mktemp -d)"
        cleanup() {
            rm -rf "$TMP_DIR"
        }
        trap cleanup EXIT

        cp -r "$SKILL_SOURCE" "$TMP_DIR/skill-optimizer"

        if [ -f "$SKILL_TARGET/.env" ]; then
            cp "$SKILL_TARGET/.env" "$TMP_DIR/skill-optimizer/.env"
        fi

        if [ -d "$SKILL_TARGET/.opt" ]; then
            rm -rf "$TMP_DIR/skill-optimizer/.opt"
            cp -R "$SKILL_TARGET/.opt" "$TMP_DIR/skill-optimizer/.opt"
        fi

        rm -rf "$SKILL_TARGET"
        mv "$TMP_DIR/skill-optimizer" "$SKILL_TARGET"
        trap - EXIT
        cleanup
    fi
else
    echo "📦 Copying skill-optimizer to .opencode/skills/..."
    cp -r "$SKILL_SOURCE" "$SKILL_TARGET"
fi

# Verify
if [ -f "$SKILL_TARGET/SKILL.md" ]; then
    echo ""
    echo "✅ Setup complete!"
    echo ""
    echo "  Source: $SKILL_SOURCE"
    echo "  Target: $SKILL_TARGET"
    echo ""
    echo "=========================================="
    echo "  Next Steps"
    echo "=========================================="
    echo ""
    echo "  1. Restart opencode to load the skill:"
    echo "     Exit current session and run 'opencode' again"
    echo ""
    echo "  2. Test the skill:"
    echo "     opencode run '帮我优化 /path/to/your/skill'"
    echo ""
    echo "  3. Or test interactively in opencode session:"
    echo "     > 帮我优化这个 skill: /path/to/skill"
    echo ""
else
    echo "❌ Error: Failed to copy skill-optimizer"
    exit 1
fi
