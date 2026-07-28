import { NextResponse } from 'next/server';

function detectPlatform(request: Request): 'windows' | 'unix' {
    const userAgent = request.headers.get('user-agent') || '';
    const platformHeader = request.headers.get('x-platform') || '';
    
    if (platformHeader) {
        return platformHeader.toLowerCase() === 'windows' ? 'windows' : 'unix';
    }
    
    if (/windows|win32|win64/i.test(userAgent)) {
        return 'windows';
    }
    
    return 'unix';
}

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const apiKey = searchParams.get('apiKey');
    const hostParam = searchParams.get('host');

    if (!apiKey || !hostParam) {
        return new NextResponse('Missing required parameters: apiKey and host', {
            status: 400,
            headers: {
                'Content-Type': 'text/plain',
            },
        });
    }

    const requestHost = request.headers.get('host') || '127.0.0.1:3000';
    const protocol = request.headers.get('x-forwarded-proto') || 'http';
    
    // Detect base path from request URL
    const requestUrl = new URL(request.url);
    const basePath = requestUrl.pathname.replace(/\/api\/setup\/auto\/?$/, '');
    
    const baseUrl = `${protocol}://${requestHost}${basePath}`;
    const platform = detectPlatform(request);

    if (platform === 'windows') {
        return generatePowerShellScript(baseUrl, hostParam, apiKey);
    }
    
    return generateBashScript(baseUrl, hostParam, apiKey);
}

function generateBashScript(baseUrl: string, hostParam: string, apiKey: string): NextResponse {
    const script = `#!/bin/bash
# =============================================================================
# Agent-insight Auto Setup (Non-Interactive)
# =============================================================================

AGENT_INSIGHT_HOST="${hostParam}"
AGENT_INSIGHT_BASE_URL="${baseUrl}"
AGENT_INSIGHT_API_KEY="${apiKey}"

echo "🚀 Fetching Agent-insight telemetry components from $AGENT_INSIGHT_BASE_URL..."

# 0. Check Node.js version
if ! command -v node &> /dev/null; then
    echo "❌ Error: Node.js is not installed."
    echo "   Agent-insight requires Node.js 20 or higher."
    echo "   Please install Node.js: https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node -v 2>/dev/null | sed "s/v//")
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 20 ]; then
    echo "❌ Error: Node.js version $NODE_VERSION is not supported."
    echo "   Agent-insight requires Node.js 20 or higher."
    echo "   Please upgrade your Node.js version: https://nodejs.org/"
    exit 1
fi
echo "✅ Node.js version: $NODE_VERSION"

# 1. Setup Directories
mkdir -p "$HOME/.agent-insight"
mkdir -p "$HOME/.agent-insight/logs"
mkdir -p "$HOME/.opencode/skills"
mkdir -p "$HOME/.claude/projects"
mkdir -p "$HOME/.openclaw/agents"
mkdir -p ".opencode/skills"
echo "📂 Created necessary directories"

# 2. Interactive Framework Selection with inquirer
echo ""

SELECTOR_SCRIPT="$HOME/.agent-insight/framework_selector.mjs"
SELECTOR_RESULT="$HOME/.agent-insight/.selector_result"

# Install inquirer and tsx if not already installed
cd "$HOME/.agent-insight"
if [ ! -d "node_modules/inquirer" ] || [ ! -d "node_modules/tsx" ]; then
    echo "📦 Installing dependencies for interactive selection..."
    npm install inquirer tsx --save 2>/dev/null
fi

cat > "$SELECTOR_SCRIPT" << 'SELECTOR_EOF'
import inquirer from 'inquirer';
import fs from 'fs';

const frameworks = [
    { name: 'OpenCode', value: 'opencode' },
    { name: 'Claude Code', value: 'claude' },
    { name: 'CodeAgent', value: 'codeagent' },
    { name: 'Hermes', value: 'hermes' },
    { name: 'OpenClaw', value: 'openclaw' },
    { name: 'JiuwenSwarm', value: 'jiuwen' },
    { name: 'TRAE AI IDE', value: 'trae' ,
];

async function select() {
    console.log('');
    console.log('\\x1b[36m%s\\x1b[0m', '╔══════════════════════════════════════════════════════════╗');
    console.log('\\x1b[36m%s\\x1b[0m', '║                                                          ║');
    console.log('\\x1b[1m\\x1b[36m%s\\x1b[0m', '║                 ✨ Agent-insight ✨                      ║');
    console.log('\\x1b[36m%s\\x1b[0m', '║                                                          ║');
    console.log('\\x1b[36m%s\\x1b[0m', '╚══════════════════════════════════════════════════════════╝');
    console.log('');
    console.log('\\x1b[90m%s\\x1b[0m', '  提示: ↑↓ 移动  |  空格 选择  |  a 全选  |  i 反选  |  Enter 确认');
    console.log('');

    const answers = await inquirer.prompt([
        {
            type: 'checkbox',
            name: 'frameworks',
            message: '集成到：',
            choices: frameworks,
            pageSize: 10,
            loop: false
        }
    ]);

    const selected = answers.frameworks;
    
    if (selected.length > 0) {
        console.log('');
        console.log('\\x1b[32m%s\\x1b[0m', '✅ 将安装以下组件:');
        selected.forEach(fw => {
            const name = frameworks.find(f => f.value === fw)?.name || fw;
            console.log('\\x1b[32m%s\\x1b[0m', '   • ' + name);
        });
        console.log('');
    } else {
        console.log('');
        console.log('\\x1b[33m%s\\x1b[0m', '⚠️  未选择任何组件，将不进行安装。');
        console.log('');
    }

    // Write result to file for bash to read
    const resultFile = process.env.SELECTOR_RESULT_FILE || process.env.HOME + '/.agent-insight/.selector_result';
    fs.writeFileSync(resultFile, selected.join(','));
}

select().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});
SELECTOR_EOF

# Run the selector interactively from /dev/tty
# Export the result file path so the selector knows where to write
export SELECTOR_RESULT_FILE="$SELECTOR_RESULT"
cd "$HOME/.agent-insight" && ./node_modules/.bin/tsx "$SELECTOR_SCRIPT" < /dev/tty

# Read the selection result from file
if [ -f "$SELECTOR_RESULT" ]; then
    SELECTED_FRAMEWORKS=$(cat "$SELECTOR_RESULT")
    rm -f "$SELECTOR_RESULT"
else
    SELECTED_FRAMEWORKS=""
fi

# Set installation flags based on selection
INSTALL_OPENCODE=false
INSTALL_CLAUDE=false
INSTALL_CODEAGENT=false
INSTALL_HERMES=false
INSTALL_OPENCLAW=false
INSTALL_JIUWEN=false
INSTALL_TRAE=false

if [[ "$SELECTED_FRAMEWORKS" == *"opencode"* ]]; then
    INSTALL_OPENCODE=true
fi
if [[ "$SELECTED_FRAMEWORKS" == *"claude"* ]]; then
    INSTALL_CLAUDE=true
fi
if [[ "$SELECTED_FRAMEWORKS" == *"codeagent"* ]]; then
    INSTALL_CODEAGENT=true
fi
if [[ "$SELECTED_FRAMEWORKS" == *"hermes"* ]]; then
    INSTALL_HERMES=true
fi
if [[ "$SELECTED_FRAMEWORKS" == *"openclaw"* ]]; then
    INSTALL_OPENCLAW=true
fi
if [[ "$SELECTED_FRAMEWORKS" == *"jiuwen"* ]]; then
    INSTALL_JIUWEN=true
fi
if [[ "$SELECTED_FRAMEWORKS" == *"trae"* ]]; then
    INSTALL_TRAE=true
fi

# Exit if nothing selected
if [ "$INSTALL_OPENCODE" = "false" ] && [ "$INSTALL_CLAUDE" = "false" ] && [ "$INSTALL_CODEAGENT" = "false" ] && [ "$INSTALL_HERMES" = "false" ] && [ "$INSTALL_OPENCLAW" = "false" ] && [ "$INSTALL_JIUWEN" = "false" ] && [ "$INSTALL_TRAE" = "false" ]; then
    echo "⚠️  未选择任何框架组件，将跳过插件安装。"
    echo "   继续执行配置步骤..."
    echo ""
fi

# 3. Download Components
if [ "$INSTALL_OPENCODE" = "true" ]; then
    OPENCODE_CONFIG_DIR="\${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
    mkdir -p "$OPENCODE_CONFIG_DIR/plugins"
    echo "⏬ Downloading OpenCode Plugin..."
    rm -f "$OPENCODE_CONFIG_DIR/plugins/Skill-Insight.ts" "$OPENCODE_CONFIG_DIR/plugins/Witty-Skill-Insight.ts" 2>/dev/null || true
    rm -f "$HOME/.opencode/plugins/Skill-Insight.ts" "$HOME/.opencode/plugins/Witty-Skill-Insight.ts" 2>/dev/null || true
    curl -sSf "$AGENT_INSIGHT_BASE_URL/api/setup/opencode" -o "$OPENCODE_CONFIG_DIR/plugins/Witty-Skill-Insight.ts"
    echo "⏬ Downloading OpenCode Uploader..."
    curl -sSf "$AGENT_INSIGHT_BASE_URL/api/setup/opencode-uploader" -o "$HOME/.agent-insight/opencode_uploader_client.js"
    echo "⏬ Installing OpenCode commands..."
    mkdir -p "$OPENCODE_CONFIG_DIR/commands"
    curl -sSf "$AGENT_INSIGHT_BASE_URL/api/setup/opencode-commands/si-optimizer" -o "$OPENCODE_CONFIG_DIR/commands/si-optimizer.md"
    echo "⏬ Downloading OpenCode TUI Plugin..."
    curl -sSf "$AGENT_INSIGHT_BASE_URL/api/setup/opencode-tui" -o "$OPENCODE_CONFIG_DIR/plugins/Witty-Skill-Insight.tui.tsx"
    export TUI_PLUGIN_PATH="$OPENCODE_CONFIG_DIR/plugins/Witty-Skill-Insight.tui.tsx"
    export TUI_CONFIG_FILE="$OPENCODE_CONFIG_DIR/tui.json"
    if command -v node &> /dev/null; then
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
    else
      echo "⚠️  node not found; skip TUI plugin config patch."
    fi
fi

if [ "$INSTALL_CLAUDE" = "true" ]; then
    echo "🛰️  Claude Code will use official OpenTelemetry logs; no session-file watcher is required."
fi

if [ "$INSTALL_HERMES" = "true" ]; then
    echo "Installing Agent Insight Hermes plugin..."
    HERMES_HOME="\${HERMES_HOME:-$HOME/.hermes}"
    HERMES_PLUGIN_DIR="$HERMES_HOME/plugins/agent_insight_hermes"
    mkdir -p "$HERMES_PLUGIN_DIR"
    curl -sSf "$AGENT_INSIGHT_BASE_URL/api/setup/hermes-plugin" -o "$HERMES_PLUGIN_DIR/__init__.py"
    cat > "$HERMES_PLUGIN_DIR/plugin.yaml" <<'HERMES_PLUGIN_EOF'
name: agent_insight_hermes
version: 0.2.0
description: Agent Insight telemetry for Hermes
provides_hooks:
  - pre_llm_call
  - post_llm_call
  - pre_api_request
  - post_api_request
  - api_request_error
  - pre_tool_call
  - post_tool_call
  - subagent_start
  - subagent_stop
  - on_session_end
HERMES_PLUGIN_EOF
    if command -v hermes >/dev/null 2>&1; then
        hermes plugins enable agent_insight_hermes || echo "Warning: enable the plugin manually with: hermes plugins enable agent_insight_hermes"
    else
        echo "Warning: hermes command not found. The plugin files were installed; enable agent_insight_hermes after installing Hermes."
    fi
fi

if [ "$INSTALL_OPENCLAW" = "true" ]; then
    echo "⏬ Downloading OpenClaw Watcher..."
    curl -sSf "$AGENT_INSIGHT_BASE_URL/api/setup/openclaw-watcher" -o "$HOME/.agent-insight/openclaw_watcher_client.ts"
fi

if [ "$INSTALL_JIUWEN" = "true" ]; then
    echo "⏬ Installing Agent-insight JiuwenSwarm extension..."
    JW_HOME="\${JIUWENSWARM_DATA_DIR:-$HOME/.jiuwenswarm}"
    JW_EXT_DIR="$JW_HOME/extensions/agent-insight-observability"
    mkdir -p "$JW_EXT_DIR" "$JW_HOME/config"
    curl -sSf "$AGENT_INSIGHT_BASE_URL/api/setup/jiuwen-extension" -o "$JW_EXT_DIR/extension.py"
    cat > "$JW_EXT_DIR/extension.yaml" <<'JIUWEN_EXT_EOF'
id: agent-insight-observability
name: agent-insight-observability
version: 0.1.0
description: Zero-code observability onboarding for JiuwenSwarm via agent-core OTLP.
author: agent-insight
min_jiuwenswarm_version: "0.2.0"
dependencies: {}
config_schema:
  type: object
JIUWEN_EXT_EOF
    echo "✅ JiuwenSwarm extension installed at $JW_EXT_DIR"
fi
if [ "$INSTALL_TRAE" = "true" ]; then
    echo "Installing TRAE AI IDE collector..."
    echo "  Step 1: Downloading VSIX..."
    TMP_VSIX="/tmp/trae-collector.vsix"
    curl -sSf "$AGENT_INSIGHT_BASE_URL/api/setup/trae" -o "$TMP_VSIX"

    INSTALLED=false
    # Try TRAE CLI first (handles extension registration automatically)
    if command -v trae-cn &>/dev/null; then
        echo "  Step 2: Installing via trae-cn CLI..."
        trae-cn --install-extension "$TMP_VSIX" --force 2>/dev/null && INSTALLED=true
    fi
    if ! $INSTALLED && command -v trae &>/dev/null; then
        echo "  Step 2: Installing via trae CLI..."
        trae --install-extension "$TMP_VSIX" --force 2>/dev/null && INSTALLED=true
    fi

    # Fallback: deploy directly to filesystem
    if ! $INSTALLED; then
        echo "  Step 2: No IDE CLI found, deploying to filesystem..."
        # Detect TRAE install directory (trae-cn or trae-cn-server)
        TRAE_ROOT=""
        for d in "$HOME/.trae-cn" "$HOME/.trae-cn-server"; do
            if [ -d "$d" ]; then TRAE_ROOT="$d"; break; fi
        done
        if [ -z "$TRAE_ROOT" ]; then
            TRAE_ROOT="$HOME/.trae-cn-server"
            echo "  (TRAE not found, using default: $TRAE_ROOT)"
        else
            echo "  Found TRAE at: $TRAE_ROOT"
        fi

        EXT_DIR="$TRAE_ROOT/extensions"
        EXT_NAME="agent-insight.agent-insight-trae-collector-0.1.0"
        TARGET="$EXT_DIR/$EXT_NAME"

        # Step 3: Extract VSIX to extensions directory
        echo "  Step 3: Extracting VSIX to $TARGET..."
        mkdir -p "$TARGET"
        unzip -o "$TMP_VSIX" -d "$TARGET" 2>/dev/null
        if [ -d "$TARGET/extension" ]; then
            cp -r "$TARGET/extension/"* "$TARGET/" 2>/dev/null
            rm -rf "$TARGET/extension" "$TARGET/extension.vsixmanifest" "$TARGET/[Content_Types].xml" 2>/dev/null
        fi

        # Step 4: Register in extensions.json (remove old + add new)
        echo "  Step 4: Registering extension..."
        EXT_JSON="$EXT_DIR/extensions.json"
        if [ -f "$EXT_JSON" ]; then
            export _EXT_JSON="$EXT_JSON" _TARGET="$TARGET" _EXT_NAME="$EXT_NAME"
            python3 << 'TRAE_PYEOF'
import json, time, os
ext_id = "agent-insight.agent-insight-trae-collector"
ext_json = os.environ["_EXT_JSON"]
target = os.environ["_TARGET"]
ext_name = os.environ["_EXT_NAME"]
with open(ext_json) as f:
    exts = json.load(f)
exts = [e for e in exts if e.get("identifier",{}).get("id","") != ext_id]
exts.append({
    "identifier": {"id": ext_id},
    "version": "0.1.0",
    "location": {"$mid": 1, "fsPath": target, "path": target, "scheme": "file"},
    "relativeLocation": ext_name,
    "metadata": {"installedTimestamp": int(time.time() * 1000), "pinned": True, "source": "vsix"}
})
with open(ext_json, "w") as f:
    json.dump(exts, f, indent=2)
TRAE_PYEOF
            echo "  [OK] Extension registered"
        else
            echo "  [WARN] extensions.json not found, extension registration skipped"
        fi
        INSTALLED=true
    fi

    # Clean stale cached copies in Trae IDE bin/ to prevent version mismatch
    for TRAE_SERVER in "$HOME/.trae-cn-server" "$HOME/.trae-cn"; do
        if [ -d "$TRAE_SERVER/bin" ]; then
            find "$TRAE_SERVER/bin" -maxdepth 3 -type d -name "agent-insight*" -exec rm -rf {} + 2>/dev/null
        fi
    done

    rm -f "$TMP_VSIX"

    # Step 5: Deploy Hook scripts (via extension setup.sh)
    EXT_NAME="agent-insight.agent-insight-trae-collector-0.1.0"
    for TRAE_BASE in "$HOME/.trae-cn" "$HOME/.trae-cn-server"; do
        SETUP_SCRIPT="$TRAE_BASE/extensions/$EXT_NAME/setup.sh"
        if [ -f "$SETUP_SCRIPT" ]; then
            echo "  Step 5: Deploying Hook scripts..."
            bash "$SETUP_SCRIPT"
            break
        fi
    done

    echo "  [OK] TRAE AI IDE collector installed"
    echo "  [NOTE] Restart TRAE IDE to activate"
fi

# 4. Configure ~/.agent-insight/.env (Auto mode - no interaction)
AGENT_INSIGHT_CONFIG_FILE="$HOME/.agent-insight/.env"
FINAL_SHOW_TASK_STATS="true"
if [ -f "$AGENT_INSIGHT_CONFIG_FILE" ]; then
  EXISTING_SHOW_TASK_STATS=$(grep '^AGENT_INSIGHT_SHOW_TASK_STATS=' "$AGENT_INSIGHT_CONFIG_FILE" | head -n 1 | cut -d'=' -f2-)
  if [ -n "$EXISTING_SHOW_TASK_STATS" ]; then
    FINAL_SHOW_TASK_STATS="$EXISTING_SHOW_TASK_STATS"
  fi
fi

# Per-account isolation: namespace opencode spool/checkpoint by API-key hash so
# switching accounts on one machine doesn't replay another account's history.
EXISTING_KEY=""
EXISTING_UPLOAD_SINCE_MS=""
if [ -f "$AGENT_INSIGHT_CONFIG_FILE" ]; then
  EXISTING_KEY=$(grep '^AGENT_INSIGHT_API_KEY=' "$AGENT_INSIGHT_CONFIG_FILE" | head -n 1 | cut -d'=' -f2-)
  EXISTING_UPLOAD_SINCE_MS=$(grep '^AGENT_INSIGHT_OPENCODE_UPLOAD_SINCE_MS=' "$AGENT_INSIGHT_CONFIG_FILE" | head -n 1 | cut -d'=' -f2-)
fi
CLIENT_KEY_HASH=$(printf '%s' "$AGENT_INSIGHT_API_KEY" | { shasum -a 256 2>/dev/null || sha256sum; } | cut -c1-16)
NOW_MS=$(node -e 'process.stdout.write(String(Date.now()))' 2>/dev/null || echo $(( $(date +%s) * 1000 )))
if [ -n "$EXISTING_UPLOAD_SINCE_MS" ] && [ "$AGENT_INSIGHT_API_KEY" = "$EXISTING_KEY" ]; then
  UPLOAD_SINCE_MS="$EXISTING_UPLOAD_SINCE_MS"
else
  UPLOAD_SINCE_MS="$NOW_MS"
fi

echo "⚙️  Updating configuration..."
touch "$AGENT_INSIGHT_CONFIG_FILE"
if [ -f "$AGENT_INSIGHT_CONFIG_FILE" ]; then
    cp "$AGENT_INSIGHT_CONFIG_FILE" "\${AGENT_INSIGHT_CONFIG_FILE}.bak"
    grep -v "^AGENT_INSIGHT_HOST=" "\${AGENT_INSIGHT_CONFIG_FILE}.bak" | grep -v "^AGENT_INSIGHT_API_KEY=" | grep -v "^AGENT_INSIGHT_SHOW_TASK_STATS=" | grep -v "^AGENT_INSIGHT_RETENTION_DAYS=" | grep -v "^AGENT_INSIGHT_OPENCODE_OTEL_ENABLE=" | grep -v "^AGENT_INSIGHT_OPENCODE_SPOOL_DIR=" | grep -v "^AGENT_INSIGHT_OPENCODE_UPLOADER=" | grep -v "^AGENT_INSIGHT_CLAUDE_OTEL_SPOOL_DIR=" | grep -v "^AGENT_INSIGHT_CODEAGENT_OTEL_SPOOL_DIR=" | grep -v "^AGENT_INSIGHT_CLAUDE_OTEL_RAW_API_BODIES=" | grep -v "^AGENT_INSIGHT_MAX_TOOL_IO=" | grep -v "^AGENT_INSIGHT_MAX_EVENT_STRING=" | grep -v "^AGENT_INSIGHT_OPENCODE_UPLOAD_COOLDOWN_MS=" | grep -v "^AGENT_INSIGHT_CLIENT_KEY_HASH=" | grep -v "^AGENT_INSIGHT_OPENCODE_CHECKPOINT=" | grep -v "^AGENT_INSIGHT_OPENCODE_UPLOAD_SINCE_MS=" > "$AGENT_INSIGHT_CONFIG_FILE"
    rm "\${AGENT_INSIGHT_CONFIG_FILE}.bak"
fi
echo "AGENT_INSIGHT_HOST=$AGENT_INSIGHT_HOST" >> "$AGENT_INSIGHT_CONFIG_FILE"
echo "AGENT_INSIGHT_API_KEY=$AGENT_INSIGHT_API_KEY" >> "$AGENT_INSIGHT_CONFIG_FILE"
echo "AGENT_INSIGHT_SHOW_TASK_STATS=$FINAL_SHOW_TASK_STATS" >> "$AGENT_INSIGHT_CONFIG_FILE"
echo "AGENT_INSIGHT_RETENTION_DAYS=10" >> "$AGENT_INSIGHT_CONFIG_FILE"
echo "AGENT_INSIGHT_OPENCODE_OTEL_ENABLE=true" >> "$AGENT_INSIGHT_CONFIG_FILE"
echo "AGENT_INSIGHT_CLIENT_KEY_HASH=$CLIENT_KEY_HASH" >> "$AGENT_INSIGHT_CONFIG_FILE"
echo "AGENT_INSIGHT_OPENCODE_SPOOL_DIR=$HOME/.agent-insight/otel_data/opencode/$CLIENT_KEY_HASH" >> "$AGENT_INSIGHT_CONFIG_FILE"
echo "AGENT_INSIGHT_OPENCODE_CHECKPOINT=$HOME/.agent-insight/opencode_uploader_checkpoint_$CLIENT_KEY_HASH.json" >> "$AGENT_INSIGHT_CONFIG_FILE"
echo "AGENT_INSIGHT_OPENCODE_UPLOAD_SINCE_MS=$UPLOAD_SINCE_MS" >> "$AGENT_INSIGHT_CONFIG_FILE"
echo "AGENT_INSIGHT_OPENCODE_UPLOADER=$HOME/.agent-insight/opencode_uploader_client.js" >> "$AGENT_INSIGHT_CONFIG_FILE"
echo "AGENT_INSIGHT_CLAUDE_OTEL_SPOOL_DIR=$HOME/.agent-insight/otel_data/claude" >> "$AGENT_INSIGHT_CONFIG_FILE"
echo "AGENT_INSIGHT_CLAUDE_OTEL_RAW_API_BODIES=file:$HOME/.agent-insight/claude_raw_bodies" >> "$AGENT_INSIGHT_CONFIG_FILE"
echo "AGENT_INSIGHT_CODEAGENT_OTEL_SPOOL_DIR=$HOME/.agent-insight/otel_data/codeagent" >> "$AGENT_INSIGHT_CONFIG_FILE"
echo "AGENT_INSIGHT_MAX_TOOL_IO=4000" >> "$AGENT_INSIGHT_CONFIG_FILE"
echo "AGENT_INSIGHT_MAX_EVENT_STRING=20000" >> "$AGENT_INSIGHT_CONFIG_FILE"
echo "AGENT_INSIGHT_OPENCODE_UPLOAD_COOLDOWN_MS=15000" >> "$AGENT_INSIGHT_CONFIG_FILE"
echo "✅ Configuration updated at $AGENT_INSIGHT_CONFIG_FILE"
echo "   AGENT_INSIGHT_HOST=$AGENT_INSIGHT_HOST"
echo "   AGENT_INSIGHT_API_KEY=********"

# 6.4 Configure Agent Insight Hermes plugin
if [ "$INSTALL_HERMES" = "true" ]; then
    HERMES_HOME="\${HERMES_HOME:-$HOME/.hermes}"
    HERMES_PLUGIN_DIR="$HERMES_HOME/plugins/agent_insight_hermes"
    mkdir -p "$HERMES_PLUGIN_DIR"
    cat > "$HERMES_PLUGIN_DIR/config.json" <<HERMES_CONFIG_EOF
{
  "host": "\${AGENT_INSIGHT_HOST%/}",
  "api_key": "$AGENT_INSIGHT_API_KEY",
  "service_name": "hermes",
  "max_content_chars": 200000,
  "spool_dir": "$HOME/.agent-insight/data/hermes-otel-spool",
  "log_file": "$HOME/.agent-insight/logs/hermes-plugin.log"
}
HERMES_CONFIG_EOF
    echo "Agent Insight Hermes config written to $HERMES_PLUGIN_DIR/config.json"
fi

# 6.45 Configure JiuwenSwarm telemetry (workspace config/.env, read by the extension)
if [ "$INSTALL_JIUWEN" = "true" ]; then
    JW_HOME="\${JIUWENSWARM_DATA_DIR:-$HOME/.jiuwenswarm}"
    JW_ENV="$JW_HOME/config/.env"
    JW_EXT_PARENT="$JW_HOME/extensions"
    JW_OTLP_HOST="$AGENT_INSIGHT_HOST"
    case "$JW_OTLP_HOST" in http://*|https://*) ;; *) JW_OTLP_HOST="http://$JW_OTLP_HOST" ;; esac
    JW_OTLP_ENDPOINT="\${JW_OTLP_HOST%/}/api/ingest/otel/v1/traces"
    mkdir -p "$JW_HOME/config"
    touch "$JW_ENV"
    cp "$JW_ENV" "\${JW_ENV}.bak"
    # EXTENSION_DIRS: 保留既有(默认 jiuwenswarm/extensions) + 追加我们的目录(去重)
    PREV_EXT_DIRS=$(grep '^EXTENSION_DIRS=' "\${JW_ENV}.bak" | head -n 1 | cut -d'=' -f2-)
    # 去掉历史值可能带的成对双引号：jiuwenswarm 模板默认 EXTENSION_DIRS=""，
    # 直接拼接会写出 "";<dir>，python-dotenv 无法解析整行而丢弃 → 扩展目录失效。
    PREV_EXT_DIRS="\${PREV_EXT_DIRS#\\"}"; PREV_EXT_DIRS="\${PREV_EXT_DIRS%\\"}"
    if [ -z "$PREV_EXT_DIRS" ]; then PREV_EXT_DIRS="jiuwenswarm/extensions"; fi
    case ";$PREV_EXT_DIRS;" in
        *";$JW_EXT_PARENT;"*) NEW_EXT_DIRS="$PREV_EXT_DIRS" ;;
        *) NEW_EXT_DIRS="$PREV_EXT_DIRS;$JW_EXT_PARENT" ;;
    esac
    grep -v '^OTEL_ENABLED=' "\${JW_ENV}.bak" | grep -v '^AGENT_INSIGHT_OTLP_ENDPOINT=' | grep -v '^AGENT_INSIGHT_API_KEY=' | grep -v '^EXTENSION_DIRS=' > "$JW_ENV"
    echo "OTEL_ENABLED=true" >> "$JW_ENV"
    echo "AGENT_INSIGHT_OTLP_ENDPOINT=$JW_OTLP_ENDPOINT" >> "$JW_ENV"
    echo "AGENT_INSIGHT_API_KEY=$AGENT_INSIGHT_API_KEY" >> "$JW_ENV"
    echo "EXTENSION_DIRS=$NEW_EXT_DIRS" >> "$JW_ENV"
    rm -f "\${JW_ENV}.bak"
    echo "✅ JiuwenSwarm telemetry configured -> $JW_OTLP_ENDPOINT (service=jiuwenswarm)"
    echo "   重启 JiuwenSwarm（agentserver）后，agent/LLM/tool trace 自动上报。"
fi

# 6. Install Watcher Dependencies (only if OpenClaw watcher is selected)
if [ "$INSTALL_OPENCLAW" = "true" ]; then
    echo ""
    echo "📦 Installing watcher dependencies..."
    if command -v npm &> /dev/null; then
      cd "$HOME/.agent-insight"
      if [ ! -f "package.json" ]; then
        echo '{"name": "agent-insight-watcher", "version": "1.0.0", "type": "module", "dependencies": {}}' > package.json
      fi
      npm install chokidar --save 2>/dev/null
      echo "✅ Dependencies installed"
    else
      echo "⚠️  npm not found. Skipping dependency installation."
    fi
fi

# 6.5 Configure Claude Code official OTel logs
if [ "$INSTALL_CLAUDE" = "true" ]; then
    cat > "$HOME/.agent-insight/claude_otel_env.sh" << 'CLAUDE_OTEL_EOF'
# Agent-Insight Claude Code OpenTelemetry integration
unalias claude 2>/dev/null || true

_skill_insight_claude_load_env() {
  if [ -f "$HOME/.agent-insight/.env" ]; then
    set -a
    . "$HOME/.agent-insight/.env"
    set +a
  fi
}

claude() {
  _skill_insight_claude_load_env
  local _si_host="\${AGENT_INSIGHT_HOST:-127.0.0.1:3000}"
  case "$_si_host" in http://*|https://*) ;; *) _si_host="http://$_si_host" ;; esac
  _si_host="\${_si_host%/}"
  mkdir -p "$HOME/.agent-insight/claude_raw_bodies" 2>/dev/null || true
  env \\
    CLAUDE_CODE_ENABLE_TELEMETRY=1 \\
    OTEL_LOGS_EXPORTER=otlp \\
    OTEL_METRICS_EXPORTER="\${OTEL_METRICS_EXPORTER:-none}" \\
    OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json \\
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT="$_si_host/api/ingest/otel/v1/logs" \\
    OTEL_EXPORTER_OTLP_HEADERS="x-witty-api-key=\${AGENT_INSIGHT_API_KEY:-}" \\
    OTEL_LOG_USER_PROMPTS=1 \\
    OTEL_LOG_TOOL_DETAILS=1 \\
    OTEL_LOG_TOOL_CONTENT=1 \\
    OTEL_LOG_RAW_API_BODIES="\${AGENT_INSIGHT_CLAUDE_OTEL_RAW_API_BODIES:-file:$HOME/.agent-insight/claude_raw_bodies}" \\
    claude "$@"
}
CLAUDE_OTEL_EOF
    SHELL_RC="$HOME/.zshrc"
    [ -f "$HOME/.bashrc" ] && SHELL_RC="$HOME/.bashrc"
    if [ -f "$SHELL_RC" ] && ! grep -q "\\.agent-insight/claude_otel_env\\.sh" "$SHELL_RC"; then
        echo "" >> "$SHELL_RC"
        echo "# Agent-Insight Claude Code OTel" >> "$SHELL_RC"
        echo "source \\"$HOME/.agent-insight/claude_otel_env.sh\\"" >> "$SHELL_RC"
    fi
    echo "✅ Claude Code OTel env installed at $HOME/.agent-insight/claude_otel_env.sh"
    echo "   Restart your terminal or run: source $HOME/.agent-insight/claude_otel_env.sh"
    pkill -f "claude_watcher_client.ts" 2>/dev/null || true
    rm -f "$HOME/.agent-insight/claude_watcher_client.ts" "$HOME/.agent-insight/start_claude_watcher.sh" "$HOME/.agent-insight/stop_claude_watcher.sh" "$HOME/.agent-insight/claude_watcher.pid"
    echo "🧹 Removed legacy Claude session-file watcher if it was installed."
fi

# 6.6 Configure CodeAgent OpenTelemetry wrapper
if [ "$INSTALL_CODEAGENT" = "true" ]; then
    cat > "$HOME/.agent-insight/codeagent_otel_env.sh" << 'CODEAGENT_OTEL_EOF'
# Agent-Insight CodeAgent OpenTelemetry integration
unalias codeagent 2>/dev/null || true

_skill_insight_codeagent_load_env() {
  if [ -f "$HOME/.agent-insight/.env" ]; then
    set -a
    . "$HOME/.agent-insight/.env"
    set +a
  fi
}

codeagent() {
  _skill_insight_codeagent_load_env
  local _si_host="\${AGENT_INSIGHT_HOST:-127.0.0.1:3000}"
  case "$_si_host" in http://*|https://*) ;; *) _si_host="http://$_si_host" ;; esac
  _si_host="\${_si_host%/}"
  env \
    CODEAGENT3_ENABLE_TELEMETRY=1 \
    OTEL_EXPORTER_OTLP_ENDPOINT="$_si_host/api/ingest/otel" \
    OTEL_EXPORTER_OTLP_PROTOCOL=http/json \
    OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json \
    OTEL_EXPORTER_OTLP_HEADERS="x-witty-api-key=\${AGENT_INSIGHT_API_KEY:-}" \
    codeagent "$@"
}

CODEAGENT_OTEL_EOF
    SHELL_RC="$HOME/.zshrc"
    [ -f "$HOME/.bashrc" ] && SHELL_RC="$HOME/.bashrc"
    if [ -f "$SHELL_RC" ] && ! grep -q "\.agent-insight/codeagent_otel_env\.sh" "$SHELL_RC"; then
        echo "" >> "$SHELL_RC"
        echo "# Agent-Insight CodeAgent OTel" >> "$SHELL_RC"
        echo "source \"$HOME/.agent-insight/codeagent_otel_env.sh\"" >> "$SHELL_RC"
    fi
    echo "✅ CodeAgent OTel env installed at $HOME/.agent-insight/codeagent_otel_env.sh"
    echo "   Restart your terminal, then run: codeagent"
    echo "   CodeAgent may still send traces/metrics; Agent Insight accepts and discards those signals."
fi

# 7. Create Watcher Startup/Stop Scripts
NEEDS_WATCHER_SCRIPTS=false
if [ "$INSTALL_OPENCLAW" = "true" ]; then
    NEEDS_WATCHER_SCRIPTS=true
fi

if [ "$NEEDS_WATCHER_SCRIPTS" = "true" ]; then
    echo ""
    echo "📝 Creating watcher management scripts..."

    # OpenClaw Watcher Start Script
    if [ "$INSTALL_OPENCLAW" = "true" ]; then
        cat > "$HOME/.agent-insight/start_openclaw_watcher.sh" << 'WATCHER_EOF'
#!/bin/bash
# Stop existing watcher if running
pkill -f "openclaw_watcher_client.ts" 2>/dev/null

# Start watcher in background
cd "$HOME/.agent-insight" && nohup npx -y tsx "$HOME/.agent-insight/openclaw_watcher_client.ts" > "$HOME/.agent-insight/logs/openclaw_watcher.log" 2>&1 &
echo $! > "$HOME/.agent-insight/openclaw_watcher.pid"
echo "OpenClaw watcher started with PID $(cat $HOME/.agent-insight/openclaw_watcher.pid)"
WATCHER_EOF
        chmod +x "$HOME/.agent-insight/start_openclaw_watcher.sh"
        echo "✅ OpenClaw watcher start script created"

        # OpenClaw Watcher Stop Script
        cat > "$HOME/.agent-insight/stop_openclaw_watcher.sh" << 'STOP_OPENCLAW_EOF'
#!/bin/bash
echo "Stopping OpenClaw watcher..."
pkill -f "openclaw_watcher_client.ts" 2>/dev/null
rm -f "$HOME/.agent-insight/openclaw_watcher.pid"
echo "OpenClaw watcher stopped"
STOP_OPENCLAW_EOF
        chmod +x "$HOME/.agent-insight/stop_openclaw_watcher.sh"
        echo "✅ OpenClaw watcher stop script created"
    fi

    # Combined Start Script - Dynamic generation
    cat > "$HOME/.agent-insight/start_watchers.sh" << 'WATCHER_HEADER'
#!/bin/bash
echo "Starting Agent-Insight watchers..."
WATCHER_HEADER

    if [ "$INSTALL_OPENCLAW" = "true" ]; then
        echo '"$HOME/.agent-insight/start_openclaw_watcher.sh"' >> "$HOME/.agent-insight/start_watchers.sh"
    fi

    echo 'echo "All watchers started!"' >> "$HOME/.agent-insight/start_watchers.sh"
    chmod +x "$HOME/.agent-insight/start_watchers.sh"
    echo "✅ Combined start script created"

    # Combined Stop Script - Dynamic generation
    cat > "$HOME/.agent-insight/stop_watchers.sh" << 'STOP_HEADER'
#!/bin/bash
echo "Stopping Agent-Insight watchers..."
STOP_HEADER

    if [ "$INSTALL_OPENCLAW" = "true" ]; then
        echo '"$HOME/.agent-insight/stop_openclaw_watcher.sh"' >> "$HOME/.agent-insight/stop_watchers.sh"
    fi

    echo 'echo "All watchers stopped!"' >> "$HOME/.agent-insight/stop_watchers.sh"
    chmod +x "$HOME/.agent-insight/stop_watchers.sh"
    echo "✅ Combined stop script created"
fi

# 8. Start Watchers Now
if [ "$NEEDS_WATCHER_SCRIPTS" = "true" ]; then
    echo ""
    echo "🚀 Starting telemetry watchers..."
    if command -v npx &> /dev/null; then
        "$HOME/.agent-insight/start_watchers.sh"
    else
        echo "⚠️  Node.js (npx) not found. Skipping watcher startup."
    fi
fi

# 10. Final Summary
echo ""
echo "🌟 Agent-Insight Telemetry: READY"
echo "------------------------------------------------"
echo "Installed Components:"
if [ "$INSTALL_OPENCODE" = "true" ]; then
    echo "  ✅ OpenCode Plugin: $OPENCODE_CONFIG_DIR/plugins/Witty-Skill-Insight.ts"
    echo "  ✅ OpenCode Command: ~/.config/opencode/commands/si-optimizer.md"
fi
if [ "$INSTALL_CLAUDE" = "true" ]; then
    echo "  ✅ Claude Code OTel: ~/.agent-insight/claude_otel_env.sh"
fi
if [ "$INSTALL_CODEAGENT" = "true" ]; then
    echo "  ✅ CodeAgent OTel: ~/.agent-insight/codeagent_otel_env.sh"
fi
if [ "$INSTALL_HERMES" = "true" ]; then
    echo "  ✅ Agent Insight Hermes Plugin: \${HERMES_HOME:-$HOME/.hermes}/plugins/agent_insight_hermes/config.json"
fi
if [ "$INSTALL_OPENCLAW" = "true" ]; then
    echo "  ✅ OpenClaw Watcher: ~/.agent-insight/openclaw_watcher_client.ts"
fi
if [ "$INSTALL_JIUWEN" = "true" ]; then
    echo "  ✅ JiuwenSwarm Extension: \${JIUWENSWARM_DATA_DIR:-$HOME/.jiuwenswarm}/extensions/agent-insight-observability (telemetry in config/.env)"
fi
if [ "$INSTALL_TRAE" = "true" ]; then
    echo "  [OK] TRAE AI IDE Collector: installed"
fi

if [ "$NEEDS_WATCHER_SCRIPTS" = "true" ]; then
    echo ""
    echo "Watcher Management:"
    echo "  Start all:    ~/.agent-insight/start_watchers.sh"
    echo "  Stop all:     ~/.agent-insight/stop_watchers.sh"
    if [ "$INSTALL_OPENCLAW" = "true" ]; then
        echo "  Start OpenClaw: ~/.agent-insight/start_openclaw_watcher.sh"
        echo "  Stop OpenClaw:  ~/.agent-insight/stop_openclaw_watcher.sh"
    fi
    echo "  Logs:         ~/.agent-insight/logs/"
fi

echo ""
echo "Usage:"
if [ "$INSTALL_OPENCODE" = "true" ]; then
    echo "  1. Run: opencode run 'hello'"
fi
if [ "$INSTALL_CLAUDE" = "true" ]; then
    echo "  2. Restart terminal, then run: claude"
fi
if [ "$INSTALL_CODEAGENT" = "true" ]; then
    echo "  3. Restart terminal, then run: codeagent"
fi
if [ "$INSTALL_HERMES" = "true" ]; then
    echo "  3. Restart Hermes or start a new Hermes conversation"
        'if [ "$INSTALL_TRAE" = "true" ]; then echo "  6. Restart TRAE IDE to activate the collector"; fi',
fi
if [ "$INSTALL_OPENCLAW" = "true" ]; then
    echo "  4. OpenClaw will automatically monitor and upload telemetry"
fi
if [ "$INSTALL_JIUWEN" = "true" ]; then
    echo "  5. Restart JiuwenSwarm (agentserver), then start a conversation"
fi
echo "------------------------------------------------"
`;

    return new NextResponse(script, {
        headers: {
            'Content-Type': 'text/x-shellscript',
        },
    });
}

function generatePowerShellScript(baseUrl: string, hostParam: string, apiKey: string): NextResponse {
    const script = [
        '# =============================================================================',
        '# Skill-insight Auto Setup (Non-Interactive) - PowerShell',
        '# =============================================================================',
        '',
        '$AGENT_INSIGHT_HOST = "' + hostParam + '"',
        '$AGENT_INSIGHT_BASE_URL = "' + baseUrl + '"',
        '$AGENT_INSIGHT_API_KEY = "' + apiKey + '"',
        '',
        'Write-Host "🚀 Fetching Skill-insight telemetry components from $AGENT_INSIGHT_BASE_URL..."',
        '',
        '# 0. Check Node.js version',
        '$nodeCmd = Get-Command node -ErrorAction SilentlyContinue',
        'if (-not $nodeCmd) {',
        '    Write-Host "❌ Error: Node.js is not installed." -ForegroundColor Red',
        '    Write-Host "   Skill-insight requires Node.js 20 or higher."',
        '    Write-Host "   Please install Node.js: https://nodejs.org/"',
        '    exit 1',
        '}',
        '',
        '$nodeVersion = (node -v 2>$null) -replace "^v", ""',
        '$nodeMajor = $nodeVersion.Split(".")[0]',
        'if ([int]$nodeMajor -lt 20) {',
        '    Write-Host "❌ Error: Node.js version $nodeVersion is not supported." -ForegroundColor Red',
        '    Write-Host "   Skill-insight requires Node.js 20 or higher."',
        '    Write-Host "   Please upgrade your Node.js version: https://nodejs.org/"',
        '    exit 1',
        '}',
        'Write-Host "✅ Node.js version: $nodeVersion"',
        '',
        '# 1. Setup Directories',
        '$skillInsightDir = Join-Path $env:USERPROFILE ".agent-insight"',
        '$skillInsightLogsDir = Join-Path $skillInsightDir "logs"',
        '$opencodePluginsDir = Join-Path $env:USERPROFILE ".opencode\\plugins"',
        '$opencodeSkillsDir = Join-Path $env:USERPROFILE ".opencode\\skills"',
        '$claudeProjectsDir = Join-Path $env:USERPROFILE ".claude\\projects"',
        '$openclawAgentsDir = Join-Path $env:USERPROFILE ".openclaw\\agents"',
        '',
        'New-Item -ItemType Directory -Force -Path $skillInsightDir | Out-Null',
        'New-Item -ItemType Directory -Force -Path $skillInsightLogsDir | Out-Null',
        'New-Item -ItemType Directory -Force -Path $opencodeSkillsDir | Out-Null',
        'New-Item -ItemType Directory -Force -Path $claudeProjectsDir | Out-Null',
        'New-Item -ItemType Directory -Force -Path $openclawAgentsDir | Out-Null',
        'New-Item -ItemType Directory -Force -Path ".opencode\\skills" | Out-Null',
        'Write-Host "📂 Created necessary directories"',
        '',
        '# 2. Interactive Framework Selection with inquirer',
        'Write-Host ""',
        '',
        '$SELECTOR_SCRIPT = Join-Path $skillInsightDir "framework_selector.mjs"',
        '$SELECTOR_RESULT = Join-Path $skillInsightDir ".selector_result"',
        '',
        '# Install inquirer and tsx if not already installed',
        'Set-Location $skillInsightDir',
        'if (-not (Test-Path "node_modules\\inquirer") -or -not (Test-Path "node_modules\\tsx")) {',
        '    Write-Host "📦 Installing dependencies for interactive selection..."',
        '    npm install inquirer tsx --save 2>$null',
        '}',
        '',
        '$selectorLines = @(',
        '    "import inquirer from \'inquirer\';"',
        '    "import fs from \'fs\';"',
        '    ""',
        '    "const frameworks = ["',
        '    "    { name: \'OpenCode\', value: \'opencode\' },"',
        '    "    { name: \'Claude Code\', value: \'claude\' },"',
        '    "    { name: \'CodeAgent\', value: \'codeagent\' },"',
        '    "    { name: \'Hermes\', value: \'hermes\' },"',
        '    "    { name: \'OpenClaw\', value: \'openclaw\' },"',
        '    "    { name: \'JiuwenSwarm\', value: \'jiuwen\' },",',
        '    "    { name: \'TRAE AI IDE\', value: \'trae\' }",',
        '    "];"',
        '    ""',
        '    "async function select() {"',
        '    "    console.log(\'\');"',
        '    "    console.log(\'\\x1b[36m%s\\x1b[0m\', \'╔══════════════════════════════════════════════════════════╗\');"',
        '    "    console.log(\'\\x1b[36m%s\\x1b[0m\', \'║                                                          ║\');"',
        '    "    console.log(\'\\x1b[1m\\x1b[36m%s\\x1b[0m\', \'║                 ✨ Skill-insight ✨                      ║\');"',
        '    "    console.log(\'\\x1b[36m%s\\x1b[0m\', \'║                                                          ║\');"',
        '    "    console.log(\'\\x1b[36m%s\\x1b[0m\', \'╚══════════════════════════════════════════════════════════╝\');"',
        '    "    console.log(\'\');"',
        '    "    console.log(\'\\x1b[90m%s\\x1b[0m\', \'  提示: ↑↓ 移动  |  空格 选择  |  a 全选  |  i 反选  |  Enter 确认\');"',
        '    "    console.log(\'\');"',
        '    ""',
        '    "    const answers = await inquirer.prompt(["',
        '    "        {"',
        '    "            type: \'checkbox\',"',
        '    "            name: \'frameworks\',"',
        '    "            message: \'集成到：\',"',
        '    "            choices: frameworks,"',
        '    "            pageSize: 10,"',
        '    "            loop: false"',
        '    "        }"',
        '    "    ]);"',
        '    ""',
        '    "    const selected = answers.frameworks;"',
        '    "    "',
        '    "    if (selected.length > 0) {"',
        '    "        console.log(\'\');"',
        '    "        console.log(\'\\x1b[32m%s\\x1b[0m\', \'✅ 将安装以下组件:\');"',
        '    "        selected.forEach(fw => {"',
        '    "            const name = frameworks.find(f => f.value === fw)?.name || fw;"',
        '    "            console.log(\'\\x1b[32m%s\\x1b[0m\', \'   • \' + name);"',
        '    "        });"',
        '    "        console.log(\'\');"',
        '    "    } else {"',
        '    "        console.log(\'\');"',
        '    "        console.log(\'\\x1b[33m%s\\x1b[0m\', \'⚠️  未选择任何组件，将不进行安装。\');"',
        '    "        console.log(\'\');"',
        '    "    }"',
        '    ""',
        '    "    // Write result to file for PowerShell to read"',
        '    "    const resultFile = process.env.SELECTOR_RESULT_FILE || process.env.USERPROFILE + \'\\\\.agent-insight\\\\.selector_result\';"',
        '    "    fs.writeFileSync(resultFile, selected.join(\',\'));"',
        '    "}"',
        '    ""',
        '    "select().catch(err => {"',
        '    "    console.error(\'Error:\', err);"',
        '    "    process.exit(1);"',
        '    "});"',
        ')',
        '$selectorContent = $selectorLines -join [char]10',
        'Set-Content -Path $SELECTOR_SCRIPT -Value $selectorContent -Encoding UTF8',
        '',
        '# Run the selector interactively',
        '$env:SELECTOR_RESULT_FILE = $SELECTOR_RESULT',
        'Set-Location $skillInsightDir',
        './node_modules/.bin/tsx $SELECTOR_SCRIPT',
        '',
        '# Read the selection result from file',
        'if (Test-Path $SELECTOR_RESULT) {',
        '    $SELECTED_FRAMEWORKS = Get-Content $SELECTOR_RESULT',
        '    Remove-Item $SELECTOR_RESULT -Force',
        '} else {',
        '    $SELECTED_FRAMEWORKS = ""',
        '}',
        '',
        '# Set installation flags based on selection',
        '$INSTALL_OPENCODE = $false',
        '$INSTALL_CLAUDE = $false',
        '$INSTALL_CODEAGENT = $false',
        '$INSTALL_HERMES = $false',
        '$INSTALL_OPENCLAW = $false',
        '$INSTALL_JIUWEN = $false',
        '$INSTALL_TRAE = $false',
        '',
        'if ($SELECTED_FRAMEWORKS -match "opencode") {',
        '    $INSTALL_OPENCODE = $true',
        '}',
        'if ($SELECTED_FRAMEWORKS -match "claude") {',
        '    $INSTALL_CLAUDE = $true',
        '}',
        'if ($SELECTED_FRAMEWORKS -match "codeagent") {',
        '    $INSTALL_CODEAGENT = $true',
        '}',
        'if ($SELECTED_FRAMEWORKS -match "hermes") {',
        '    $INSTALL_HERMES = $true',
        '}',
        'if ($SELECTED_FRAMEWORKS -match "openclaw") {',
        '    $INSTALL_OPENCLAW = $true',
        '}',
        'if ($SELECTED_FRAMEWORKS -match "jiuwen") {',
        '    $INSTALL_JIUWEN = $true',
        '}',
        'if ($SELECTED_FRAMEWORKS -match "trae") {',
        '    $INSTALL_TRAE = $true',
        '}',
        '',
        '# Exit if nothing selected',
        'if (-not $INSTALL_OPENCODE -and -not $INSTALL_CLAUDE -and -not $INSTALL_CODEAGENT -and -not $INSTALL_HERMES -and -not $INSTALL_OPENCLAW -and -not $INSTALL_JIUWEN -and -not $INSTALL_TRAE) {',
        '    Write-Host "⚠️  未选择任何框架组件，将跳过插件安装。"',
        '    Write-Host "   继续执行配置步骤..."',
        '    Write-Host ""',
        '}',
        '',
        '# 3. Download Components',
        'if ($INSTALL_OPENCODE) {',
        '    Write-Host "⏬ Downloading OpenCode Plugin..."',
        '    $opencodeConfigDir = Join-Path $env:USERPROFILE ".config\\opencode"',
        '    New-Item -ItemType Directory -Path (Join-Path $opencodeConfigDir "plugins") -Force | Out-Null',
        '    Remove-Item -Path (Join-Path $opencodeConfigDir "plugins\\Skill-Insight.ts") -Force -ErrorAction SilentlyContinue',
        '    Remove-Item -Path (Join-Path $opencodeConfigDir "plugins\\Witty-Skill-Insight.ts") -Force -ErrorAction SilentlyContinue',
        '    Remove-Item -Path (Join-Path $opencodePluginsDir "Skill-Insight.ts") -Force -ErrorAction SilentlyContinue',
        '    Remove-Item -Path (Join-Path $opencodePluginsDir "Witty-Skill-Insight.ts") -Force -ErrorAction SilentlyContinue',
        '    Invoke-WebRequest -Uri "$AGENT_INSIGHT_BASE_URL/api/setup/opencode" -OutFile (Join-Path $opencodeConfigDir "plugins\\Witty-Skill-Insight.ts")',
        '    Write-Host "⏬ Downloading OpenCode Uploader..."',
        '    Invoke-WebRequest -Uri "$AGENT_INSIGHT_BASE_URL/api/setup/opencode-uploader" -OutFile (Join-Path $skillInsightDir "opencode_uploader_client.js")',
        '    Write-Host "⏬ Downloading OpenCode TUI Plugin..."',
        '    $tuiPluginPath = Join-Path $opencodeConfigDir "plugins\\Witty-Skill-Insight.tui.tsx"',
        '    Invoke-WebRequest -Uri "$AGENT_INSIGHT_BASE_URL/api/setup/opencode-tui" -OutFile $tuiPluginPath',
        '    $tuiConfigFile = Join-Path $opencodeConfigDir "tui.json"',
        '    try {',
        '        $data = @{}',
        '        if (Test-Path $tuiConfigFile) {',
        '            $raw = Get-Content $tuiConfigFile -Raw',
        '            if ($raw -and $raw.Trim()) { $data = $raw | ConvertFrom-Json }',
        '        }',
        '        if (-not $data.plugin) { $data | Add-Member -MemberType NoteProperty -Name plugin -Value @() -Force }',
        '        if ($data.plugin -notcontains $tuiPluginPath) { $data.plugin += $tuiPluginPath }',
        '        $data | ConvertTo-Json -Depth 10 | Set-Content -Path $tuiConfigFile -Encoding UTF8',
        '    } catch {',
        '        Write-Host "⚠️  Failed to patch tui.json for TUI plugin."',
        '    }',
        '}',
        '',
        'if ($INSTALL_CLAUDE) {',
        '    Write-Host "🛰️  Claude Code will use official OpenTelemetry logs; no session-file watcher is required."',
        '}',
        '',
        'if ($INSTALL_HERMES) {',
        '    Write-Host "Installing Agent Insight Hermes plugin..."',
        '    $hermesHome = if ($env:HERMES_HOME) { $env:HERMES_HOME } else { Join-Path $env:USERPROFILE ".hermes" }',
        '    $hermesPluginDir = Join-Path $hermesHome "plugins\\agent_insight_hermes"',
        '    New-Item -ItemType Directory -Path $hermesPluginDir -Force | Out-Null',
        '    Invoke-WebRequest -Uri "$AGENT_INSIGHT_BASE_URL/api/setup/hermes-plugin" -OutFile (Join-Path $hermesPluginDir "__init__.py")',
        '    @("name: agent_insight_hermes", "version: 0.2.0", "description: Agent Insight telemetry for Hermes", "provides_hooks:", "  - pre_llm_call", "  - post_llm_call", "  - pre_api_request", "  - post_api_request", "  - api_request_error", "  - pre_tool_call", "  - post_tool_call", "  - subagent_start", "  - subagent_stop", "  - on_session_end") | Set-Content -Path (Join-Path $hermesPluginDir "plugin.yaml") -Encoding UTF8',
        '    $hermesCmd = Get-Command hermes -ErrorAction SilentlyContinue',
        '    if ($hermesCmd) {',
        '        & $hermesCmd.Source plugins enable agent_insight_hermes',
        '    } else {',
        '        Write-Host "Warning: hermes command not found. The plugin files were installed; enable agent_insight_hermes after installing Hermes."',
        '    }',
        '}',
        '',
        'if ($INSTALL_OPENCLAW) {',
        '    Write-Host "⏬ Downloading OpenClaw Watcher..."',
        '    Invoke-WebRequest -Uri "$AGENT_INSIGHT_BASE_URL/api/setup/openclaw-watcher" -OutFile (Join-Path $skillInsightDir "openclaw_watcher_client.ts")',
        '}',
        '',
        'if ($INSTALL_JIUWEN) {',
        '    Write-Host "⏬ Installing Agent-insight JiuwenSwarm extension..."',
        '    $jwHome = if ($env:JIUWENSWARM_DATA_DIR) { $env:JIUWENSWARM_DATA_DIR } else { Join-Path $env:USERPROFILE ".jiuwenswarm" }',
        '    $jwExtDir = Join-Path $jwHome "extensions\\agent-insight-observability"',
        '    New-Item -ItemType Directory -Path $jwExtDir -Force | Out-Null',
        '    New-Item -ItemType Directory -Path (Join-Path $jwHome "config") -Force | Out-Null',
        '    Invoke-WebRequest -Uri "$AGENT_INSIGHT_BASE_URL/api/setup/jiuwen-extension" -OutFile (Join-Path $jwExtDir "extension.py")',
        '    @(\'id: agent-insight-observability\', \'name: agent-insight-observability\', \'version: 0.1.0\', \'description: Zero-code observability onboarding for JiuwenSwarm via agent-core OTLP.\', \'author: agent-insight\', \'min_jiuwenswarm_version: "0.2.0"\', \'dependencies: {}\', \'config_schema:\', \'  type: object\') | Set-Content -Path (Join-Path $jwExtDir "extension.yaml") -Encoding UTF8',
        '    Write-Host "✅ JiuwenSwarm extension installed at $jwExtDir"',
        '}',
        '',
        'if ($INSTALL_TRAE) {',
        '    Write-Host "Installing TRAE AI IDE collector..."',
        '    $tmpVsix = Join-Path $env:TEMP "trae-collector.vsix"',
        '    Write-Host "  Step 1: Downloading VSIX..."',
        '    (New-Object System.Net.WebClient).DownloadFile("$AGENT_INSIGHT_BASE_URL/api/setup/trae", $tmpVsix)',
        '',
        '    $installed = $false',
        '    # Try TRAE CLI first (check PATH + common install locations)',
        '    $traeCli = Get-Command trae-cn -ErrorAction SilentlyContinue',
        '    if (-not $traeCli) {',
        '        $traeDirs = @("$env:LOCALAPPDATA\\Programs\\trae-cn", "$env:APPDATA\\trae-cn")',
        '        foreach ($d in $traeDirs) {',
        '            $bin = Join-Path $d "bin\\trae-cn.cmd"',
        '            if (Test-Path $bin) { $traeCli = $bin; break }',
        '        }',
        '    }',
        '    if (-not $traeCli) { $traeCli = Get-Command trae -ErrorAction SilentlyContinue }',
        '    if ($traeCli) {',
        '        Write-Host "  Step 2: Installing via CLI..."',
        '        & $traeCli --install-extension $tmpVsix --force',
        '        if ($LASTEXITCODE -eq 0) { $installed = $true }',
        '    }',
        '',
        '    if (-not $installed) {',
        '        Write-Host "  Step 2: No CLI found, deploying to filesystem..."',
        '        $traeRoot = $null',
        '        foreach ($d in @("$env:USERPROFILE\\.trae-cn", "$env:USERPROFILE\\.trae-cn-server")) {',
        '            if (Test-Path $d) { $traeRoot = $d; break }',
        '        }',
        '        if (-not $traeRoot) { $traeRoot = "$env:USERPROFILE\\.trae-cn-server" }',
        '',
        '        $extDir = Join-Path $traeRoot "extensions"',
        '        $extName = "agent-insight.agent-insight-trae-collector-0.1.0"',
        '        $target = Join-Path $extDir $extName',
        '',
        '        Write-Host "  Step 3: Extracting VSIX to $target..."',
        '        if (Test-Path $target) { Remove-Item $target -Recurse -Force }',
        '        Add-Type -AssemblyName System.IO.Compression.FileSystem',
        '        [System.IO.Compression.ZipFile]::ExtractToDirectory($tmpVsix, $target)',
        '        # Move files from extension/ subdirectory to root',
        '        $extSubDir = Join-Path $target "extension"',
        '        if (Test-Path $extSubDir) {',
        '            Get-ChildItem $extSubDir | Copy-Item -Destination $target -Recurse -Force',
        '            Remove-Item $extSubDir -Recurse -Force',
        '            Remove-Item (Join-Path $target "extension.vsixmanifest") -Force -ErrorAction SilentlyContinue',
        '            Remove-Item (Join-Path $target "[Content_Types].xml") -Force -ErrorAction SilentlyContinue',
        '        }',
        '',
        '        Write-Host "  Step 4: Registering extension..."',
        '        $extJson = Join-Path $extDir "extensions.json"',
        '        $extId = "agent-insight.agent-insight-trae-collector"',
        '        $ts = [int64]((Get-Date).ToUniversalTime() - (Get-Date "1970-01-01")).TotalMilliseconds',
        '        $normalizedTarget = $target -replace \'\\\\\', \'/\'',
        '        $nodeScript = @\'',
        'const fs = require("fs");',
        'const extJson = process.argv[2];',
        'const fsPath = process.argv[3];',
        'const normPath = process.argv[4];',
        'const extName = process.argv[5];',
        'const extId = process.argv[6];',
        'const ts = parseInt(process.argv[7], 10);',
        'const newEntry = {',
        '    identifier: { id: extId },',
        '    version: "0.1.0",',
        '    location: { "$mid": 1, fsPath: fsPath, path: normPath, scheme: "file" },',
        '    relativeLocation: extName,',
        '    metadata: { isMachineScoped: true, installedTimestamp: ts, pinned: true, source: "vsix" }',
        '};',
        'let raw = "";',
        'if (fs.existsSync(extJson)) {',
        '    let buf = fs.readFileSync(extJson);',
        '    if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) { buf = buf.slice(3); }',
        '    raw = buf.toString("utf8").trim();',
        '}',
        'if (!raw) {',
        '    fs.writeFileSync(extJson, JSON.stringify([newEntry], null, 2));',
        '    console.log("Created new extensions.json");',
        '} else {',
        '    try {',
        '        let data = JSON.parse(raw);',
        '        let exts = Array.isArray(data) ? data : (data && Array.isArray(data.value) ? data.value : [data]);',
        '        exts = exts.filter(e => e && e.identifier && e.identifier.id !== extId);',
        '        exts.push(newEntry);',
        '        fs.writeFileSync(extJson, JSON.stringify(exts, null, 2));',
        '        console.log("Extension registered successfully, total:", exts.length);',
        '    } catch (e) {',
        '        console.error("JSON parse failed, using string append:", e.message);',
        '        if (raw.startsWith("[") && raw.endsWith("]")) {',
        '            const insertPos = raw.lastIndexOf("]");',
        '            const before = raw.slice(0, insertPos).trimEnd();',
        '            const sep = before.length > 0 && before.endsWith("}") ? ",\\n" : "";',
        '            const newContent = before + sep + JSON.stringify(newEntry, null, 2) + "\\n" + raw.slice(insertPos);',
        '            fs.writeFileSync(extJson, newContent);',
        '            console.log("Appended via string mode");',
        '        } else {',
        '            fs.writeFileSync(extJson, JSON.stringify([newEntry], null, 2));',
        '            console.log("Recreated extensions.json");',
        '        }',
        '    }',
        '}',
        '\'@',
        '        $nodeScriptPath = Join-Path $env:TEMP "register-trae-ext.js"',
        '        Set-Content -Path $nodeScriptPath -Value $nodeScript -Encoding UTF8',
        '        node $nodeScriptPath $extJson $target $normalizedTarget $extName $extId $ts',
        '        Remove-Item $nodeScriptPath -Force -ErrorAction SilentlyContinue',
        '        $installed = $true',
        '    }',
        '',
        '    Remove-Item $tmpVsix -Force -ErrorAction SilentlyContinue',
        '',
        '    Write-Host "  Step 5: Deploying Hook scripts..."',
        '    $setupScript = Join-Path $target "setup.ps1"',
        '    if (Test-Path $setupScript) {',
        '        powershell -ExecutionPolicy Bypass -File $setupScript',
        '    } else {',
        '        Write-Host "  [WARN] setup.ps1 not found"',
        '    }',
        '',
        '    Write-Host "  [OK] TRAE AI IDE collector installed"',
        '    Write-Host "  [NOTE] Restart TRAE IDE to activate"',
        '}',
        '',
        '# 4. Configure ~/.agent-insight/.env (Auto mode - no interaction)',
        '$AGENT_INSIGHT_CONFIG_FILE = Join-Path $skillInsightDir ".env"',
        '',
        '# Per-account isolation: namespace opencode spool/checkpoint by API-key hash.',
        '$EXISTING_KEY = ""',
        '$EXISTING_UPLOAD_SINCE_MS = ""',
        'if (Test-Path $AGENT_INSIGHT_CONFIG_FILE) {',
        '    $prevContent = Get-Content $AGENT_INSIGHT_CONFIG_FILE',
        '    $kl = ($prevContent | Where-Object { $_ -match "^AGENT_INSIGHT_API_KEY=" } | Select-Object -First 1)',
        '    if ($kl) { $EXISTING_KEY = ($kl -split "=", 2)[1] }',
        '    $sl = ($prevContent | Where-Object { $_ -match "^AGENT_INSIGHT_OPENCODE_UPLOAD_SINCE_MS=" } | Select-Object -First 1)',
        '    if ($sl) { $EXISTING_UPLOAD_SINCE_MS = ($sl -split "=", 2)[1] }',
        '}',
        '$CLIENT_KEY_HASH = ([System.BitConverter]::ToString(([System.Security.Cryptography.SHA256]::Create()).ComputeHash([System.Text.Encoding]::UTF8.GetBytes([string]$AGENT_INSIGHT_API_KEY))) -replace \'-\',\'\').ToLower().Substring(0,16)',
        '$NOW_MS = [string][long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())',
        'if ($EXISTING_UPLOAD_SINCE_MS -and ($AGENT_INSIGHT_API_KEY -eq $EXISTING_KEY)) { $UPLOAD_SINCE_MS = $EXISTING_UPLOAD_SINCE_MS } else { $UPLOAD_SINCE_MS = $NOW_MS }',
        '',
        'Write-Host "⚙️  Updating configuration..."',
        'if (Test-Path $AGENT_INSIGHT_CONFIG_FILE) {',
        '    $existingContent = Get-Content $AGENT_INSIGHT_CONFIG_FILE',
        '    $existingShow = ($existingContent | Where-Object { $_ -match "^AGENT_INSIGHT_SHOW_TASK_STATS=" } | Select-Object -First 1)',
        '    $showValue = "true"',
        '    if ($existingShow) { $showValue = ($existingShow -split "=", 2)[1] }',
        '    $filteredContent = $existingContent | Where-Object { $_ -notmatch "^AGENT_INSIGHT_HOST=" -and $_ -notmatch "^AGENT_INSIGHT_API_KEY=" -and $_ -notmatch "^AGENT_INSIGHT_SHOW_TASK_STATS=" -and $_ -notmatch "^AGENT_INSIGHT_RETENTION_DAYS=" -and $_ -notmatch "^AGENT_INSIGHT_OPENCODE_OTEL_ENABLE=" -and $_ -notmatch "^AGENT_INSIGHT_OPENCODE_SPOOL_DIR=" -and $_ -notmatch "^AGENT_INSIGHT_OPENCODE_UPLOADER=" -and $_ -notmatch "^AGENT_INSIGHT_CLAUDE_OTEL_SPOOL_DIR=" -and $_ -notmatch "^AGENT_INSIGHT_CODEAGENT_OTEL_SPOOL_DIR=" -and $_ -notmatch "^AGENT_INSIGHT_CLAUDE_OTEL_RAW_API_BODIES=" -and $_ -notmatch "^AGENT_INSIGHT_MAX_TOOL_IO=" -and $_ -notmatch "^AGENT_INSIGHT_MAX_EVENT_STRING=" -and $_ -notmatch "^AGENT_INSIGHT_OPENCODE_UPLOAD_COOLDOWN_MS=" -and $_ -notmatch "^AGENT_INSIGHT_CLIENT_KEY_HASH=" -and $_ -notmatch "^AGENT_INSIGHT_OPENCODE_CHECKPOINT=" -and $_ -notmatch "^AGENT_INSIGHT_OPENCODE_UPLOAD_SINCE_MS=" }',
        '    Set-Content -Path $AGENT_INSIGHT_CONFIG_FILE -Value $filteredContent',
        '} else {',
        '    $envLines = @()',
        '    $showValue = "true"',
        '}',
        'Add-Content -Path $AGENT_INSIGHT_CONFIG_FILE -Value "AGENT_INSIGHT_HOST=$AGENT_INSIGHT_HOST"',
        'Add-Content -Path $AGENT_INSIGHT_CONFIG_FILE -Value "AGENT_INSIGHT_API_KEY=$AGENT_INSIGHT_API_KEY"',
        'Add-Content -Path $AGENT_INSIGHT_CONFIG_FILE -Value "AGENT_INSIGHT_SHOW_TASK_STATS=$showValue"',
        'Add-Content -Path $AGENT_INSIGHT_CONFIG_FILE -Value "AGENT_INSIGHT_RETENTION_DAYS=10"',
        'Add-Content -Path $AGENT_INSIGHT_CONFIG_FILE -Value "AGENT_INSIGHT_OPENCODE_OTEL_ENABLE=true"',
        'Add-Content -Path $AGENT_INSIGHT_CONFIG_FILE -Value "AGENT_INSIGHT_CLIENT_KEY_HASH=$CLIENT_KEY_HASH"',
        'Add-Content -Path $AGENT_INSIGHT_CONFIG_FILE -Value "AGENT_INSIGHT_OPENCODE_SPOOL_DIR=$skillInsightDir\\otel_data\\opencode\\$CLIENT_KEY_HASH"',
        'Add-Content -Path $AGENT_INSIGHT_CONFIG_FILE -Value "AGENT_INSIGHT_OPENCODE_CHECKPOINT=$skillInsightDir\\opencode_uploader_checkpoint_$CLIENT_KEY_HASH.json"',
        'Add-Content -Path $AGENT_INSIGHT_CONFIG_FILE -Value "AGENT_INSIGHT_OPENCODE_UPLOAD_SINCE_MS=$UPLOAD_SINCE_MS"',
        'Add-Content -Path $AGENT_INSIGHT_CONFIG_FILE -Value "AGENT_INSIGHT_OPENCODE_UPLOADER=$skillInsightDir\\opencode_uploader_client.js"',
        'Add-Content -Path $AGENT_INSIGHT_CONFIG_FILE -Value "AGENT_INSIGHT_CLAUDE_OTEL_SPOOL_DIR=$skillInsightDir\\otel_data\\claude"',
        'Add-Content -Path $AGENT_INSIGHT_CONFIG_FILE -Value "AGENT_INSIGHT_CLAUDE_OTEL_RAW_API_BODIES=file:$skillInsightDir\\claude_raw_bodies"',
        'Add-Content -Path $AGENT_INSIGHT_CONFIG_FILE -Value "AGENT_INSIGHT_CODEAGENT_OTEL_SPOOL_DIR=$skillInsightDir\\otel_data\\codeagent"',
        'Add-Content -Path $AGENT_INSIGHT_CONFIG_FILE -Value "AGENT_INSIGHT_MAX_TOOL_IO=4000"',
        'Add-Content -Path $AGENT_INSIGHT_CONFIG_FILE -Value "AGENT_INSIGHT_MAX_EVENT_STRING=20000"',
        'Add-Content -Path $AGENT_INSIGHT_CONFIG_FILE -Value "AGENT_INSIGHT_OPENCODE_UPLOAD_COOLDOWN_MS=15000"',
        'Write-Host "✅ Configuration updated at $AGENT_INSIGHT_CONFIG_FILE"',
        'Write-Host "   AGENT_INSIGHT_HOST=$AGENT_INSIGHT_HOST"',
        'Write-Host "   AGENT_INSIGHT_API_KEY=********"',
        '',
        '# 6.4 Configure Agent Insight Hermes plugin',
        'if ($INSTALL_HERMES) {',
        '    $hermesHome = if ($env:HERMES_HOME) { $env:HERMES_HOME } else { Join-Path $env:USERPROFILE ".hermes" }',
        '    $hermesPluginDir = Join-Path $hermesHome "plugins\\agent_insight_hermes"',
        '    New-Item -ItemType Directory -Path $hermesPluginDir -Force | Out-Null',
        '    $hermesConfig = @{ host = $AGENT_INSIGHT_HOST.TrimEnd("/"); api_key = $AGENT_INSIGHT_API_KEY; service_name = "hermes"; max_content_chars = 200000; spool_dir = (Join-Path $skillInsightDir "data\\hermes-otel-spool"); log_file = (Join-Path $skillInsightDir "logs\\hermes-plugin.log") } | ConvertTo-Json',
        '    Set-Content -Path (Join-Path $hermesPluginDir "config.json") -Value $hermesConfig -Encoding UTF8',
        '    Write-Host "Agent Insight Hermes config written to $hermesPluginDir\\config.json"',
        '}',
        '',
        '# 6.45 Configure JiuwenSwarm telemetry (workspace config\\.env, read by the extension)',
        'if ($INSTALL_JIUWEN) {',
        '    $jwHome = if ($env:JIUWENSWARM_DATA_DIR) { $env:JIUWENSWARM_DATA_DIR } else { Join-Path $env:USERPROFILE ".jiuwenswarm" }',
        '    $jwEnv = Join-Path $jwHome "config\\.env"',
        '    $jwExtParent = Join-Path $jwHome "extensions"',
        '    $jwOtlpHost = if ($AGENT_INSIGHT_HOST -match "^https?://") { $AGENT_INSIGHT_HOST } else { "http://$AGENT_INSIGHT_HOST" }',
        '    $jwOtlpEndpoint = $jwOtlpHost.TrimEnd("/") + "/api/ingest/otel/v1/traces"',
        '    New-Item -ItemType Directory -Path (Join-Path $jwHome "config") -Force | Out-Null',
        '    New-Item -ItemType File -Path $jwEnv -Force | Out-Null',
        '    $jwPrev = Get-Content $jwEnv',
        '    $prevExtLine = $jwPrev | Select-String \'^EXTENSION_DIRS=\' | Select-Object -First 1',
        '    # 去掉历史值可能带的成对引号（模板默认 EXTENSION_DIRS=""），否则拼出 "";<dir> 会破坏 dotenv 解析',
        '    $prevExtDirs = if ($prevExtLine) { $prevExtLine.Line.Substring(\'EXTENSION_DIRS=\'.Length).Trim(\'"\').Trim("\'") } else { "jiuwenswarm/extensions" }',
        '    if (-not $prevExtDirs) { $prevExtDirs = "jiuwenswarm/extensions" }',
        '    if ($prevExtDirs.Split(";") -notcontains $jwExtParent) { $newExtDirs = "$prevExtDirs;$jwExtParent" } else { $newExtDirs = $prevExtDirs }',
        '    $jwPrev | Where-Object { $_ -notmatch \'^OTEL_ENABLED=\' -and $_ -notmatch \'^AGENT_INSIGHT_OTLP_ENDPOINT=\' -and $_ -notmatch \'^AGENT_INSIGHT_API_KEY=\' -and $_ -notmatch \'^EXTENSION_DIRS=\' } | Set-Content $jwEnv',
        '    Add-Content $jwEnv "OTEL_ENABLED=true"',
        '    Add-Content $jwEnv "AGENT_INSIGHT_OTLP_ENDPOINT=$jwOtlpEndpoint"',
        '    Add-Content $jwEnv "AGENT_INSIGHT_API_KEY=$AGENT_INSIGHT_API_KEY"',
        '    Add-Content $jwEnv "EXTENSION_DIRS=$newExtDirs"',
        '    Write-Host "✅ JiuwenSwarm telemetry configured -> $jwOtlpEndpoint (service=jiuwenswarm)"',
        '}',
        '',
        '# 6. Install Watcher Dependencies (only if OpenClaw watcher is selected)',
        'if ($INSTALL_OPENCLAW) {',
        '    Write-Host ""',
        '    Write-Host "📦 Installing watcher dependencies..."',
        '    if (Get-Command npm -ErrorAction SilentlyContinue) {',
        '        Set-Location $skillInsightDir',
        '        if (-not (Test-Path "package.json")) {',
        '            \'{"name": "skill-insight-watcher", "version": "1.0.0", "type": "module", "dependencies": {}}\' | Out-File -FilePath "package.json" -Encoding utf8',
        '        }',
        '        npm install chokidar --save 2>$null',
        '        Write-Host "✅ Dependencies installed"',
        '    } else {',
        '        Write-Host "⚠️  npm not found. Skipping dependency installation."',
        '    }',
        '}',
        '',
        '# 6.5 Configure Claude Code official OTel logs',
        'if ($INSTALL_CLAUDE) {',
        '    $claudeOtelScript = @\'',
        'function Invoke-SkillInsightClaude {',
        '  $envFile = Join-Path $env:USERPROFILE ".agent-insight\\.env"',
        '  if (Test-Path $envFile) {',
        '    Get-Content $envFile | ForEach-Object {',
        '      if ($_ -match "^([^#=]+)=(.*)$") { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], "Process") }',
        '    }',
        '  }',
        '  $siHost = if ($env:AGENT_INSIGHT_HOST) { $env:AGENT_INSIGHT_HOST } else { "127.0.0.1:3000" }',
        '  if ($siHost -notmatch "^https?://") { $siHost = "http://$siHost" }',
        '  $siHost = $siHost.TrimEnd("/")',
        '  $env:CLAUDE_CODE_ENABLE_TELEMETRY = "1"',
        '  $env:OTEL_LOGS_EXPORTER = "otlp"',
        '  if (-not $env:OTEL_METRICS_EXPORTER) { $env:OTEL_METRICS_EXPORTER = "none" }',
        '  $env:OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = "http/json"',
        '  $env:OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = "$siHost/api/ingest/otel/v1/logs"',
        '  $env:OTEL_EXPORTER_OTLP_HEADERS = "x-witty-api-key=$($env:AGENT_INSIGHT_API_KEY)"',
        '  $env:OTEL_LOG_USER_PROMPTS = "1"',
        '  $env:OTEL_LOG_TOOL_DETAILS = "1"',
        '  $env:OTEL_LOG_TOOL_CONTENT = "1"',
        '  $rawBodyDir = Join-Path $env:USERPROFILE ".agent-insight\\claude_raw_bodies"',
        '  New-Item -ItemType Directory -Path $rawBodyDir -Force | Out-Null',
        '  if (-not $env:AGENT_INSIGHT_CLAUDE_OTEL_RAW_API_BODIES) { $env:AGENT_INSIGHT_CLAUDE_OTEL_RAW_API_BODIES = "file:$rawBodyDir" }',
        '  $env:OTEL_LOG_RAW_API_BODIES = $env:AGENT_INSIGHT_CLAUDE_OTEL_RAW_API_BODIES',
        '  $cmd = Get-Command claude -CommandType Application -ErrorAction SilentlyContinue',
        '  if (-not $cmd) { throw "claude executable not found in PATH" }',
        '  & $cmd.Source @args',
        '}',
        'Set-Alias claude Invoke-SkillInsightClaude',
        '\'@',
        '    $claudeOtelPath = Join-Path $skillInsightDir "claude_otel_env.ps1"',
        '    Set-Content -Path $claudeOtelPath -Value $claudeOtelScript -Encoding UTF8',
        '    $profileDir = Split-Path $PROFILE -Parent',
        '    if ($profileDir) { New-Item -ItemType Directory -Path $profileDir -Force | Out-Null }',
        '    $profileText = if (Test-Path $PROFILE) { Get-Content $PROFILE -Raw } else { "" }',
        '    if (-not ($profileText.Contains(".agent-insight\\claude_otel_env.ps1") -or $profileText.Contains(".agent-insight/claude_otel_env.ps1"))) {',
        '        Add-Content -Path $PROFILE -Value ""',
        '        Add-Content -Path $PROFILE -Value "# Skill-Insight Claude Code OTel"',
        '        Add-Content -Path $PROFILE -Value ". `"$claudeOtelPath`""',
        '    }',
        '    Write-Host "✅ Claude Code OTel env installed at $claudeOtelPath"',
        '    Write-Host "   Restart PowerShell or run: . `"$claudeOtelPath`""',
        '    Get-Process | Where-Object { $_.CommandLine -like "*claude_watcher_client.ts*" } | Stop-Process -Force -ErrorAction SilentlyContinue',
        '    Remove-Item (Join-Path $skillInsightDir "claude_watcher_client.ts"), (Join-Path $skillInsightDir "start_claude_watcher.ps1"), (Join-Path $skillInsightDir "stop_claude_watcher.ps1"), (Join-Path $skillInsightDir "claude_watcher.pid") -Force -ErrorAction SilentlyContinue',
        '    Write-Host "🧹 Removed legacy Claude session-file watcher if it was installed."',
        '}',
        '',
        '# 6.6a Configure CodeAgent OpenTelemetry wrapper',
        'if ($INSTALL_CODEAGENT) {',
        '    $codeAgentOtelScript = @\'',
        'function Invoke-AgentInsightCodeAgent {',
        '  $envFile = Join-Path (Join-Path $env:USERPROFILE ".agent-insight") ".env"',
        '  if (Test-Path $envFile) {',
        '    Get-Content $envFile | ForEach-Object {',
        '      if ($_ -match "^([^#=]+)=(.*)$") { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], "Process") }',
        '    }',
        '  }',
        '  $siHost = if ($env:AGENT_INSIGHT_HOST) { $env:AGENT_INSIGHT_HOST } else { "127.0.0.1:3000" }',
        '  if ($siHost -notmatch "^https?://") { $siHost = "http://$siHost" }',
        '  $siHost = $siHost.TrimEnd("/")',
        '  $env:CODEAGENT3_ENABLE_TELEMETRY = "1"',
        '  $env:OTEL_EXPORTER_OTLP_ENDPOINT = "$siHost/api/ingest/otel"',
        '  $env:OTEL_EXPORTER_OTLP_PROTOCOL = "http/json"',
        '  $env:OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = "http/json"',
        '  $env:OTEL_EXPORTER_OTLP_HEADERS = "x-witty-api-key=$($env:AGENT_INSIGHT_API_KEY)"',
        '  $command = Get-Command codeagent -CommandType Application, ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1',
        '  if (-not $command) { throw "CodeAgent executable not found in PATH." }',
        '  & $command.Source @args',
        '}',
        'Set-Alias codeagent Invoke-AgentInsightCodeAgent',
        '\'@',
        '    $codeAgentOtelPath = Join-Path $skillInsightDir "codeagent_otel_env.ps1"',
        '    Set-Content -Path $codeAgentOtelPath -Value $codeAgentOtelScript -Encoding UTF8',
        '    $profileDir = Split-Path $PROFILE -Parent',
        '    if ($profileDir) { New-Item -ItemType Directory -Path $profileDir -Force | Out-Null }',
        '    if (-not (Test-Path $PROFILE) -or -not ((Get-Content $PROFILE -Raw) -match "codeagent_otel_env.ps1")) {',
        '        Add-Content -Path $PROFILE -Value ""',
        '        Add-Content -Path $PROFILE -Value "# Agent-Insight CodeAgent OTel"',
        '        Add-Content -Path $PROFILE -Value ". `"$codeAgentOtelPath`""',
        '    }',
        '    Write-Host "✅ CodeAgent OTel env installed at $codeAgentOtelPath"',
        '    Write-Host "   Restart PowerShell, then run: codeagent"',
        '    Write-Host "   CodeAgent may still send traces/metrics; Agent Insight accepts and discards those signals."',
        '}',
        '',
        '# 7. Create Watcher Startup/Stop Scripts',
        '$NEEDS_WATCHER_SCRIPTS = $INSTALL_OPENCLAW',
        '',
        'if ($NEEDS_WATCHER_SCRIPTS) {',
        '    Write-Host ""',
        '    Write-Host "📝 Creating watcher management scripts..."',
        '',
        '    # OpenClaw Watcher Start Script',
        '    if ($INSTALL_OPENCLAW) {',
        '        $startOpenclawScript = @\'',
        '# Stop existing watcher if running',
        'Get-Process | Where-Object { $_.CommandLine -like "*openclaw_watcher_client.ts*" } | Stop-Process -Force -ErrorAction SilentlyContinue',
        '',
        '# Start watcher in background',
        '$skillInsightDir = Join-Path $env:USERPROFILE ".agent-insight"',
        '$logFile = Join-Path $skillInsightDir "logs\\openclaw_watcher.log"',
        '$scriptPath = Join-Path $skillInsightDir "openclaw_watcher_client.ts"',
        '',
        'Start-Process -FilePath "npx" -ArgumentList "-y", "tsx", $scriptPath -NoNewWindow -RedirectStandardOutput $logFile -RedirectStandardError $logFile',
        'Write-Host "OpenClaw watcher started"',
        '\'@',
        '        $startOpenclawPath = Join-Path $skillInsightDir "start_openclaw_watcher.ps1"',
        '        Set-Content -Path $startOpenclawPath -Value $startOpenclawScript -Encoding UTF8',
        '        Write-Host "✅ OpenClaw watcher start script created"',
        '',
        '        # OpenClaw Watcher Stop Script',
        '        $stopOpenclawScript = @\'',
        'Write-Host "Stopping OpenClaw watcher..."',
        'Get-Process | Where-Object { $_.CommandLine -like "*openclaw_watcher_client.ts*" } | Stop-Process -Force -ErrorAction SilentlyContinue',
        'Write-Host "OpenClaw watcher stopped"',
        '\'@',
        '        $stopOpenclawPath = Join-Path $skillInsightDir "stop_openclaw_watcher.ps1"',
        '        Set-Content -Path $stopOpenclawPath -Value $stopOpenclawScript -Encoding UTF8',
        '        Write-Host "✅ OpenClaw watcher stop script created"',
        '    }',
        '',
        '    # Combined Start Script',
        '    $startLines = @()',
        '    $startLines += \'Write-Host "Starting Skill-Insight watchers..."\'',
        '    if ($INSTALL_OPENCLAW) {',
        '        $startLines += \'powershell -File "\' + $skillInsightDir + \'\\start_openclaw_watcher.ps1"\'',
        '    }',
        '    $startLines += \'Write-Host "All watchers started!"\'',
        '    $startLines -join [char]10 | Set-Content -Path (Join-Path $skillInsightDir "start_watchers.ps1") -Encoding UTF8',
        '    Write-Host "✅ Combined start script created"',
        '',
        '    # Combined Stop Script',
        '    $stopLines = @()',
        '    $stopLines += \'Write-Host "Stopping Skill-Insight watchers..."\'',
        '    if ($INSTALL_OPENCLAW) {',
        '        $stopLines += \'powershell -File "\' + $skillInsightDir + \'\\stop_openclaw_watcher.ps1"\'',
        '    }',
        '    $stopLines += \'Write-Host "All watchers stopped!"\'',
        '    $stopLines -join [char]10 | Set-Content -Path (Join-Path $skillInsightDir "stop_watchers.ps1") -Encoding UTF8',
        '    Write-Host "✅ Combined stop script created"',
        '}',
        '',
        '# 8. Start Watchers Now',
        'if ($NEEDS_WATCHER_SCRIPTS) {',
        '    Write-Host ""',
        '    Write-Host "🚀 Starting telemetry watchers..."',
        '    if (Get-Command npx -ErrorAction SilentlyContinue) {',
        '        & (Join-Path $skillInsightDir "start_watchers.ps1")',
        '    } else {',
        '        Write-Host "⚠️  Node.js (npx) not found. Skipping watcher startup."',
        '    }',
        '}',
        '',
        '# 10. Final Summary',
        'Write-Host ""',
        'Write-Host "🌟 Skill-Insight Telemetry: READY"',
        'Write-Host "------------------------------------------------"',
        'Write-Host "Installed Components:"',
        'if ($INSTALL_OPENCODE) {',
        '    Write-Host "  ✅ OpenCode Plugin: $opencodeConfigDir\\plugins\\Witty-Skill-Insight.ts"',
        '}',
        'if ($INSTALL_CLAUDE) {',
        '    Write-Host "  ✅ Claude Code OTel: ~/.agent-insight/claude_otel_env.ps1"',
        '}',
        'if ($INSTALL_CODEAGENT) {',
        '    Write-Host "  ✅ CodeAgent OTel: ~/.agent-insight/codeagent_otel_env.ps1"',
        '}',
        'if ($INSTALL_HERMES) {',
        '    $summaryHermesHome = if ($env:HERMES_HOME) { $env:HERMES_HOME } else { Join-Path $env:USERPROFILE ".hermes" }',
        '    Write-Host "  ✅ Agent Insight Hermes Plugin: $summaryHermesHome\\plugins\\agent_insight_hermes\\config.json"',
        '}',
        'if ($INSTALL_OPENCLAW) {',
        '    Write-Host "  ✅ OpenClaw Watcher: ~/.agent-insight/openclaw_watcher_client.ts"',
        '}',
        'if ($INSTALL_JIUWEN) { $summaryJwHome = if ($env:JIUWENSWARM_DATA_DIR) { $env:JIUWENSWARM_DATA_DIR } else { Join-Path $env:USERPROFILE ".jiuwenswarm" }; Write-Host "  ✅ JiuwenSwarm Extension: $summaryJwHome\\extensions\\agent-insight-observability (telemetry in config\\.env)" }',
                'if (\$INSTALL_TRAE) {',
                '    Write-Host "  [OK] TRAE AI IDE Collector: ~/.trae-cn-server/extensions/agent-insight.agent-insight-trae-collector-0.1.0"',
                '}',
        '',
        'if ($NEEDS_WATCHER_SCRIPTS) {',
        '    Write-Host ""',
        '    Write-Host "Watcher Management:"',
        '    Write-Host "  Start all:    ~/.agent-insight/start_watchers.ps1"',
        '    Write-Host "  Stop all:     ~/.agent-insight/stop_watchers.ps1"',
        '    if ($INSTALL_OPENCLAW) {',
        '        Write-Host "  Start OpenClaw: ~/.agent-insight/start_openclaw_watcher.ps1"',
        '        Write-Host "  Stop OpenClaw:  ~/.agent-insight/stop_openclaw_watcher.ps1"',
        '    }',
        '    Write-Host "  Logs:         ~/.agent-insight/logs/"',
        '}',
        '',
        'Write-Host ""',
        'Write-Host "Usage:"',
        'if ($INSTALL_OPENCODE) {',
        '    Write-Host "  1. Run: opencode run \'hello\'"',
        '}',
        'if ($INSTALL_CLAUDE) {',
        '    Write-Host "  2. Restart PowerShell, then run: claude"',
        '}',
        'if ($INSTALL_CODEAGENT) {',
        '    Write-Host "  3. Restart PowerShell, then run: codeagent"',
        '}',
        'if ($INSTALL_HERMES) {',
        '    Write-Host "  3. Restart Hermes or start a new Hermes conversation"',
        '}',
        'if ($INSTALL_OPENCLAW) {',
        '    Write-Host "  4. OpenClaw will automatically monitor and upload telemetry"',
        '}',
        'if ($INSTALL_JIUWEN) {',
        '    Write-Host "  5. Restart JiuwenSwarm (agentserver), then start a conversation"',
        '}',
        'Write-Host "------------------------------------------------"',
    ].join('\n');

    // 加入 UTF-8 BOM (\uFEFF) 以及正确的 Content-Type 防止 PowerShell 中文乱码和解析错误
    return new NextResponse('\uFEFF' + script, {
        headers: {
            'Content-Type': 'application/x-powershell; charset=utf-8',
        },
    });
}
