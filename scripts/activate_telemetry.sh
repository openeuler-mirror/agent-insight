#!/bin/bash

# =============================================================================
# Skill-Insight Official Setup Script (Fixed Path Logic)
# 
# Installs native telemetry hooks for Claude Code and OpenCode.
# =============================================================================

# Define project root relative to this script's location
# Using a more robust way to handle 'source' from different shells
if [ -n "$BASH_SOURCE" ]; then
    SELF_PATH="$BASH_SOURCE"
else
    SELF_PATH="$0"
fi

# Go to script dir, then up to project root
SCRIPTS_DIR="$( cd -- "$( dirname -- "$SELF_PATH" )" &> /dev/null && pwd )"
PROJECT_ROOT="$( dirname "$SCRIPTS_DIR" )"

echo "🚀 Starting Skill-Insight Telemetry Setup..."
echo "📂 Project Root: $PROJECT_ROOT"

# --- 1. Load Configurations ---
if [ -f "$PROJECT_ROOT/.env" ]; then
    export $(grep -v '^#' "$PROJECT_ROOT/.env" | xargs)
    echo "✅ Configuration loaded from .env"
fi

# --- 2. Setup OpenCode Plugin (Priority) ---
OPENCODE_PLUGIN_SRC="$SCRIPTS_DIR/opencode_plugin.ts"
OPENCODE_PLUGIN_DEST="$HOME/.opencode/plugins/Witty-Skill-Insight.ts"
OPENCODE_TUI_PLUGIN_SRC="$SCRIPTS_DIR/opencode_tui_plugin.tsx"
OPENCODE_TUI_PLUGIN_DEST="$HOME/.opencode/plugins/Witty-Skill-Insight.tui.tsx"
OPENCODE_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
OPENCODE_CONFIG_PLUGIN_DIR="$OPENCODE_CONFIG_DIR/plugins"

if [ -f "$OPENCODE_PLUGIN_SRC" ]; then
    echo "🛠️  Syncing OpenCode Plugin..."
    
    # Create plugin directory
    mkdir -p "$HOME/.opencode/plugins"
    mkdir -p "$OPENCODE_CONFIG_PLUGIN_DIR"
    cp "$OPENCODE_PLUGIN_SRC" "$OPENCODE_PLUGIN_DEST"
    cp "$OPENCODE_PLUGIN_SRC" "$OPENCODE_CONFIG_PLUGIN_DIR/Witty-Skill-Insight.ts"
    echo "✅ OpenCode Plugin installed to $OPENCODE_PLUGIN_DEST"
    
    if [ -f "$OPENCODE_TUI_PLUGIN_SRC" ]; then
        cp "$OPENCODE_TUI_PLUGIN_SRC" "$OPENCODE_TUI_PLUGIN_DEST"
        cp "$OPENCODE_TUI_PLUGIN_SRC" "$OPENCODE_CONFIG_PLUGIN_DIR/Witty-Skill-Insight.tui.tsx"
        echo "✅ OpenCode TUI Plugin installed to $OPENCODE_TUI_PLUGIN_DEST"
        if command -v node &> /dev/null; then
            export TUI_PLUGIN_PATH="$OPENCODE_CONFIG_PLUGIN_DIR/Witty-Skill-Insight.tui.tsx"
            export TUI_CONFIG_FILE="$OPENCODE_CONFIG_DIR/tui.json"
            node - <<'NODE'
const fs = require("fs");
const path = require("path");
const file = process.env.TUI_CONFIG_FILE;
const pluginPath = process.env.TUI_PLUGIN_PATH;
let data = {};
try {
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, "utf8");
    data = text && text.trim() ? JSON.parse(text) : {};
  }
} catch {}
if (!data || typeof data !== "object") data = {};
const list = Array.isArray(data.plugin) ? data.plugin.slice() : [];
if (pluginPath && !list.includes(pluginPath)) list.push(pluginPath);
data.plugin = list;
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(data, null, 2));
NODE
        fi
    fi

    # --- 2.1 Setup Skill-Insight Config (~/.skill-insight/.env) ---
    SKILL_INSIGHT_CONFIG_DIR="$HOME/.skill-insight"
    SKILL_INSIGHT_CONFIG_FILE="$SKILL_INSIGHT_CONFIG_DIR/.env"
    mkdir -p "$SKILL_INSIGHT_CONFIG_DIR"

    EXISTING_KEY=""
    EXISTING_HOST=""
    EXISTING_SHOW_TASK_STATS=""
    if [ -f "$SKILL_INSIGHT_CONFIG_FILE" ]; then
        # match only UNCOMMENTED lines
        EXISTING_KEY=$(grep '^SKILL_INSIGHT_API_KEY=' "$SKILL_INSIGHT_CONFIG_FILE" | head -n 1 | cut -d'=' -f2-)
        EXISTING_HOST=$(grep '^SKILL_INSIGHT_HOST=' "$SKILL_INSIGHT_CONFIG_FILE" | head -n 1 | cut -d'=' -f2-)
        EXISTING_SHOW_TASK_STATS=$(grep '^SKILL_INSIGHT_SHOW_TASK_STATS=' "$SKILL_INSIGHT_CONFIG_FILE" | head -n 1 | cut -d'=' -f2-)
    fi

    # API Key Selection Logic
    API_KEY=""
    if [ -n "$EXISTING_KEY" ]; then
        echo "🔑 Found existing API Key in $SKILL_INSIGHT_CONFIG_FILE."
        read -p "👉 Use existing key? (y/N, Default: y): " USE_EXISTING < /dev/tty
        if [[ "$USE_EXISTING" =~ ^[Nn]$ ]]; then
            read -p "👉 Please enter your NEW API Key: " API_KEY < /dev/tty
        else
            API_KEY="$EXISTING_KEY"
        fi
    elif [ -n "$SKILL_INSIGHT_API_KEY" ]; then
        echo "🔑 Found API Key in current environment/env file: $SKILL_INSIGHT_API_KEY"
        read -p "👉 Use this key for global config? (y/N, Default: y): " USE_ENV < /dev/tty
        if [[ "$USE_ENV" =~ ^[Nn]$ ]]; then
            read -p "👉 Please enter your API Key: " API_KEY < /dev/tty
        else
            API_KEY="$SKILL_INSIGHT_API_KEY"
        fi
    else
        read -p "👉 Please enter your API Key: " API_KEY < /dev/tty
    fi

    # -- Host Logic --
    NEW_HOST="${SKILL_INSIGHT_HOST:-127.0.0.1:3000}"
    FINAL_HOST="$NEW_HOST"
    if [ -n "$EXISTING_HOST" ] && [ "$EXISTING_HOST" != "$NEW_HOST" ]; then
        echo "🌐 Current Host in global config: $EXISTING_HOST"
        echo "🌐 New Host detected: $NEW_HOST"
        read -p "👉 Change to new Host? (y/N, Default: y): " CHANGE_HOST < /dev/tty
        if [[ "$CHANGE_HOST" =~ ^[Nn]$ ]]; then
            FINAL_HOST="$EXISTING_HOST"
        fi
    fi

    if [ -z "$API_KEY" ]; then
        echo "⚠️  Warning: No API Key provided. Data reporting will fail."
    fi
    
    FINAL_SHOW_TASK_STATS="$EXISTING_SHOW_TASK_STATS"
    if [ -z "$FINAL_SHOW_TASK_STATS" ]; then
        FINAL_SHOW_TASK_STATS="true"
    fi

    echo "⚙️  Syncing configuration to $SKILL_INSIGHT_CONFIG_FILE..."
    touch "$SKILL_INSIGHT_CONFIG_FILE"
    cp "$SKILL_INSIGHT_CONFIG_FILE" "${SKILL_INSIGHT_CONFIG_FILE}.bak"
    grep -v "^SKILL_INSIGHT_API_KEY=" "${SKILL_INSIGHT_CONFIG_FILE}.bak" | grep -v "^SKILL_INSIGHT_HOST=" | grep -v "^SKILL_INSIGHT_SHOW_TASK_STATS=" > "$SKILL_INSIGHT_CONFIG_FILE"
    echo "SKILL_INSIGHT_API_KEY=$API_KEY" >> "$SKILL_INSIGHT_CONFIG_FILE"
    echo "SKILL_INSIGHT_HOST=$FINAL_HOST" >> "$SKILL_INSIGHT_CONFIG_FILE"
    echo "SKILL_INSIGHT_SHOW_TASK_STATS=$FINAL_SHOW_TASK_STATS" >> "$SKILL_INSIGHT_CONFIG_FILE"
    rm "${SKILL_INSIGHT_CONFIG_FILE}.bak"
    echo "✅ Configuration updated (Other settings preserved)."

    # NEW: Register Sync Hook into .zshrc / .bashrc
    SYNC_SCRIPT="$HOME/.skill-insight/sync_skills.js"
    if [ -f "$SYNC_SCRIPT" ]; then
        SHELL_RC="$HOME/.zshrc"
        [ -f "$HOME/.bashrc" ] && SHELL_RC="$HOME/.bashrc"
        
        # Add aliases if not present
        if ! grep -q "witty_sync_wrapper" "$SHELL_RC"; then
            echo "" >> "$SHELL_RC"
            echo "# Skill-Insight Auto-Sync" >> "$SHELL_RC"
            echo "alias opencode='node $SYNC_SCRIPT --agent opencode && opencode'" >> "$SHELL_RC"
            echo "alias claude='node $SYNC_SCRIPT --agent claude && claude'" >> "$SHELL_RC"
            echo "✅ Auto-sync aliases added to $SHELL_RC"
        fi
    fi

else
    echo "❌ Error: OpenCode plugin source not found at $OPENCODE_PLUGIN_SRC"
fi

# --- 3. Setup Claude Code Hook ---
CLAUDE_HOOK="$SCRIPTS_DIR/capture_claude.js"
if [ -f "$CLAUDE_HOOK" ]; then
    echo "🛠️  Configuring Claude Code Hook..."
    chmod +x "$CLAUDE_HOOK"
    if command -v claude &> /dev/null; then
        # Check for active Claude processes which can cause config locks/hangs
        CLAUDE_PIDS=$(pgrep -x claude 2>/dev/null)
        if [ -n "$CLAUDE_PIDS" ]; then
            echo "⚠️  Detected running Claude Code process(es): $CLAUDE_PIDS"
            echo "   Active sessions can prevent configuration updates from completing."
            read -p "👉 Would you like to terminate these processes to speed up registration? (y/N): " KILL_CLAUDE < /dev/tty
            if [[ "$KILL_CLAUDE" =~ ^[Yy]$ ]]; then
                echo "🔪 Terminating Claude processes..."
                kill -9 $CLAUDE_PIDS 2>/dev/null
                sleep 1
            else
                echo "⏳ Continuing (Warning: this step may hang if Claude is busy)..."
            fi
        fi

        claude config set hooks.Stop "$CLAUDE_HOOK" >/dev/null 2>&1
        echo "✅ Claude Hook registered: $CLAUDE_HOOK"
    fi
else
    echo "❌ Error: Claude hook script not found at $CLAUDE_HOOK"
fi

# --- 4. Final Cleanup ---
unset ANTHROPIC_BASE_URL
unset DEEPSEEK_BASE_URL
unset OPENAI_BASE_URL

echo ""
echo "🌟 Skill-Insight Telemetry: READY"
echo "------------------------------------------------"
echo "To test, run: opencode run 'hello'"
echo ""
