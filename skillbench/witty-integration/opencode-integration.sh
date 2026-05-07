#!/bin/bash
# =============================================================================
# Skill-insight One-Click Setup
# =============================================================================

apt-get update
apt-get install -y curl

curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | bash

source "$HOME/.nvm/nvm.sh"

nvm install 22
npm -v


SKILL_INSIGHT_CONFIG_FILE="$HOME/.skill-insight/.env"
EXISTING_KEY=""
EXISTING_HOST=""
if [ -f "$SKILL_INSIGHT_CONFIG_FILE" ]; then
    SKILL_INSIGHT_BASE_URL=$(grep '^SKILL_INSIGHT_BASE_URL=' "$SKILL_INSIGHT_CONFIG_FILE" | head -n 1 | cut -d'=' -f2-)
    SKILL_INSIGHT_HOST=$(grep '^SKILL_INSIGHT_HOST=' "$SKILL_INSIGHT_CONFIG_FILE" | head -n 1 | cut -d'=' -f2-)
    EXISTING_KEY=$(grep '^SKILL_INSIGHT_API_KEY=' "$SKILL_INSIGHT_CONFIG_FILE" | head -n 1 | cut -d'=' -f2-)
    EXISTING_HOST=$(grep '^SKILL_INSIGHT_HOST=' "$SKILL_INSIGHT_CONFIG_FILE" | head -n 1 | cut -d'=' -f2-)
    
fi
echo "CURRENT KEY $EXISTING_KEY"
echo "CURRENT skilhost $SKILL_INSIGHT_HOST"
echo "CURRENT ex_host $EXISTING_HOST"
echo "CURRENT base url $SKILL_INSIGHT_BASE_URL"

echo "🚀 Fetching Skill-insight telemetry components from $SKILL_INSIGHT_BASE_URL..."

# 1. Setup Directories
mkdir -p "$HOME/.skill-insight"
mkdir -p "$HOME/.skill-insight/logs"
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
    echo "⏬ Downloading OpenCode Plugin... {$SKILL_INSIGHT_BASE_URL/sync_skills.ts}"
    curl -sSf "$SKILL_INSIGHT_BASE_URL/api/setup/opencode" -o "$HOME/.opencode/plugins/Witty-Skill-Insight.ts"
fi

# 4. Configure ~/.skill-insight/.env

# -- API Key Logic --
FINAL_KEY="$EXISTING_KEY"

# -- Host Logic --
FINAL_HOST="$EXISTING_HOST"

if [ -z "$FINAL_KEY" ]; then
    echo "⚠️  Warning: No API Key provided. Telemetry upload will fail until you set it in $SKILL_INSIGHT_CONFIG_FILE"
fi

echo "⚙️  Updating configuration..."
touch "$SKILL_INSIGHT_CONFIG_FILE"
cp "$SKILL_INSIGHT_CONFIG_FILE" "${SKILL_INSIGHT_CONFIG_FILE}.bak"
grep -v "^SKILL_INSIGHT_HOST=" "${SKILL_INSIGHT_CONFIG_FILE}.bak" | grep -v "^SKILL_INSIGHT_API_KEY=" > "$SKILL_INSIGHT_CONFIG_FILE"
echo "SKILL_INSIGHT_HOST=$FINAL_HOST" >> "$SKILL_INSIGHT_CONFIG_FILE"
# echo "WITTY_INSIGHT_API_KEY=$FINAL_KEY" >> "$SKILL_INSIGHT_CONFIG_FILE"
echo "SKILL_INSIGHT_API_KEY=$FINAL_KEY" >> "$SKILL_INSIGHT_CONFIG_FILE"
# echo "WITTY_INSIGHT_HOST=$SKILL_INSIGHT_BASE_URL" >> "$SKILL_INSIGHT_CONFIG_FILE"
rm "${SKILL_INSIGHT_CONFIG_FILE}.bak"
echo "✅ Configuration updated at $SKILL_INSIGHT_CONFIG_FILE"

# 10. Final Summary
echo ""
echo "🌟 Skill-Insight Telemetry: READY"
echo "------------------------------------------------"
echo "Installed Components:"
if [ "$INSTALL_OPENCODE" = "true" ]; then echo "  ✅ OpenCode Plugin: ~/.opencode/plugins/Witty-Skill-Insight.ts"; fi

echo ""
echo "Usage:"
if [ "$INSTALL_OPENCODE" = "true" ]; then echo "  1. Run: opencode run 'hello'"; fi
echo "------------------------------------------------"