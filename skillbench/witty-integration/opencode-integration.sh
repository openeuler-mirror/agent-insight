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

# =============================================================================
# Agent-insight One-Click Setup
# =============================================================================

apt-get update
apt-get install -y curl

curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | bash

source "$HOME/.nvm/nvm.sh"

nvm install 22
npm -v


AGENT_INSIGHT_CONFIG_FILE="$HOME/.agent-insight/.env"
EXISTING_KEY=""
EXISTING_HOST=""
if [ -f "$AGENT_INSIGHT_CONFIG_FILE" ]; then
    AGENT_INSIGHT_BASE_URL=$(grep '^AGENT_INSIGHT_BASE_URL=' "$AGENT_INSIGHT_CONFIG_FILE" | head -n 1 | cut -d'=' -f2-)
    AGENT_INSIGHT_HOST=$(grep '^AGENT_INSIGHT_HOST=' "$AGENT_INSIGHT_CONFIG_FILE" | head -n 1 | cut -d'=' -f2-)
    EXISTING_KEY=$(grep '^AGENT_INSIGHT_API_KEY=' "$AGENT_INSIGHT_CONFIG_FILE" | head -n 1 | cut -d'=' -f2-)
    EXISTING_HOST=$(grep '^AGENT_INSIGHT_HOST=' "$AGENT_INSIGHT_CONFIG_FILE" | head -n 1 | cut -d'=' -f2-)
    
fi
echo "CURRENT KEY $EXISTING_KEY"
echo "CURRENT skilhost $AGENT_INSIGHT_HOST"
echo "CURRENT ex_host $EXISTING_HOST"
echo "CURRENT base url $AGENT_INSIGHT_BASE_URL"

echo "🚀 Fetching Agent-insight telemetry components from $AGENT_INSIGHT_BASE_URL..."

# 1. Setup Directories
mkdir -p "$HOME/.agent-insight"
mkdir -p "$HOME/.agent-insight/logs"
mkdir -p "$HOME/.opencode/plugins"
mkdir -p "$HOME/.opencode/skills"
mkdir -p "$HOME/.claude/projects"
mkdir -p "$HOME/.openclaw/agents"
mkdir -p ".opencode/skills"
echo "📂 Created necessary directories"

# Set installation flags based on selection
INSTALL_OPENCODE=true
# 3. Download Components
if [ "$INSTALL_OPENCODE" = "true" ]; then
    echo "⏬ Downloading OpenCode Plugin... {$AGENT_INSIGHT_BASE_URL/sync_skills.ts}"
    curl -sSf "$AGENT_INSIGHT_BASE_URL/api/setup/opencode" -o "$HOME/.opencode/plugins/Witty-Skill-Insight.ts"
fi

# 4. Configure ~/.agent-insight/.env

# -- API Key Logic --
FINAL_KEY="$EXISTING_KEY"

# -- Host Logic --
FINAL_HOST="$EXISTING_HOST"

if [ -z "$FINAL_KEY" ]; then
    echo "⚠️  Warning: No API Key provided. Telemetry upload will fail until you set it in $AGENT_INSIGHT_CONFIG_FILE"
fi

echo "⚙️  Updating configuration..."
touch "$AGENT_INSIGHT_CONFIG_FILE"
cp "$AGENT_INSIGHT_CONFIG_FILE" "${AGENT_INSIGHT_CONFIG_FILE}.bak"
grep -v "^AGENT_INSIGHT_HOST=" "${AGENT_INSIGHT_CONFIG_FILE}.bak" | grep -v "^AGENT_INSIGHT_API_KEY=" > "$AGENT_INSIGHT_CONFIG_FILE"
echo "AGENT_INSIGHT_HOST=$FINAL_HOST" >> "$AGENT_INSIGHT_CONFIG_FILE"
# echo "WITTY_INSIGHT_API_KEY=$FINAL_KEY" >> "$AGENT_INSIGHT_CONFIG_FILE"
echo "AGENT_INSIGHT_API_KEY=$FINAL_KEY" >> "$AGENT_INSIGHT_CONFIG_FILE"
# echo "WITTY_INSIGHT_HOST=$AGENT_INSIGHT_BASE_URL" >> "$AGENT_INSIGHT_CONFIG_FILE"
rm "${AGENT_INSIGHT_CONFIG_FILE}.bak"
echo "✅ Configuration updated at $AGENT_INSIGHT_CONFIG_FILE"

# 10. Final Summary
echo ""
echo "🌟 Agent-Insight Telemetry: READY"
echo "------------------------------------------------"
echo "Installed Components:"
if [ "$INSTALL_OPENCODE" = "true" ]; then echo "  ✅ OpenCode Plugin: ~/.opencode/plugins/Witty-Skill-Insight.ts"; fi

echo ""
echo "Usage:"
if [ "$INSTALL_OPENCODE" = "true" ]; then echo "  1. Run: opencode run 'hello'"; fi
echo "------------------------------------------------"
