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


# Setup script for skill-generator testing
# This script copies skill-generator to .opencode/skills directory

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../" && pwd)"
SKILL_SOURCE="$PROJECT_ROOT/skills/skill-generator"
SKILL_TARGET="$PROJECT_ROOT/.opencode/skills/skill-generator"
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
echo "  Skill Generator Setup Script"
echo "=========================================="
echo ""

# Check if source exists
if [ ! -d "$SKILL_SOURCE" ]; then
    echo "❌ Error: skill-generator source not found at:"
    echo "   $SKILL_SOURCE"
    exit 1
fi

if [ ! -f "$SKILL_SOURCE/SKILL.md" ]; then
    echo "❌ Error: SKILL.md not found in skill-generator"
    exit 1
fi

# Create target directory if not exists
mkdir -p "$PROJECT_ROOT/.opencode/skills"

if [ -d "$SKILL_TARGET" ]; then
    if [ "$OVERWRITE_LOCAL" = true ]; then
        echo "🔄 Removing existing skill-generator..."
        rm -rf "$SKILL_TARGET"
        echo "📦 Copying skill-generator to .opencode/skills/..."
        cp -r "$SKILL_SOURCE" "$SKILL_TARGET"
    else
        echo "ℹ️ Preserving existing .env and .opt/ in target (use --overwrite-local to override)"
        TMP_DIR="$(mktemp -d)"
        cleanup() {
            rm -rf "$TMP_DIR"
        }
        trap cleanup EXIT

        cp -r "$SKILL_SOURCE" "$TMP_DIR/skill-generator"

        if [ -f "$SKILL_TARGET/.env" ]; then
            cp "$SKILL_TARGET/.env" "$TMP_DIR/skill-generator/.env"
        fi

        if [ -d "$SKILL_TARGET/.opt" ]; then
            rm -rf "$TMP_DIR/skill-generator/.opt"
            cp -R "$SKILL_TARGET/.opt" "$TMP_DIR/skill-generator/.opt"
        fi

        rm -rf "$SKILL_TARGET"
        mv "$TMP_DIR/skill-generator" "$SKILL_TARGET"
        trap - EXIT
        cleanup
    fi
else
    echo "📦 Copying skill-generator to .opencode/skills/..."
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
    echo "     opencode run '把一个 fault mode 改写成 skill：/path/to/your/fault-mode.md'"
    echo ""
    echo "  3. Or test interactively in opencode session:"
    echo "     > 把一个 fault mode 改写成 skill：/path/to/fault-mode.md"
    echo ""
else
    echo "❌ Error: Failed to copy skill-generator"
    exit 1
fi
