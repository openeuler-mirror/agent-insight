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
# Skill-insight Auto Setup (Non-Interactive)
# =============================================================================

SKILL_INSIGHT_HOST="${hostParam}"
SKILL_INSIGHT_BASE_URL="${baseUrl}"
SKILL_INSIGHT_API_KEY="${apiKey}"

echo "🚀 Fetching Skill-insight telemetry components from $SKILL_INSIGHT_BASE_URL..."

# 0. Check Node.js version
if ! command -v node &> /dev/null; then
    echo "❌ Error: Node.js is not installed."
    echo "   Skill-insight requires Node.js 20 or higher."
    echo "   Please install Node.js: https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node -v 2>/dev/null | sed "s/v//")
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 20 ]; then
    echo "❌ Error: Node.js version $NODE_VERSION is not supported."
    echo "   Skill-insight requires Node.js 20 or higher."
    echo "   Please upgrade your Node.js version: https://nodejs.org/"
    exit 1
fi
echo "✅ Node.js version: $NODE_VERSION"

# 1. Setup Directories
mkdir -p "$HOME/.skill-insight"
mkdir -p "$HOME/.skill-insight/logs"
mkdir -p "$HOME/.opencode/plugins"
mkdir -p "$HOME/.opencode/skills"
mkdir -p "$HOME/.claude/projects"
mkdir -p "$HOME/.openclaw/agents"
mkdir -p ".opencode/skills"
echo "📂 Created necessary directories"

# 2. Interactive Framework Selection with inquirer
echo ""

SELECTOR_SCRIPT="$HOME/.skill-insight/framework_selector.mjs"
SELECTOR_RESULT="$HOME/.skill-insight/.selector_result"

# Install inquirer and tsx if not already installed
cd "$HOME/.skill-insight"
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
    { name: 'OpenClaw', value: 'openclaw' }
];

async function select() {
    console.log('');
    console.log('\\x1b[36m%s\\x1b[0m', '╔══════════════════════════════════════════════════════════╗');
    console.log('\\x1b[36m%s\\x1b[0m', '║                                                          ║');
    console.log('\\x1b[1m\\x1b[36m%s\\x1b[0m', '║                 ✨ Skill-insight ✨                      ║');
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
    const resultFile = process.env.SELECTOR_RESULT_FILE || process.env.HOME + '/.skill-insight/.selector_result';
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
cd "$HOME/.skill-insight" && ./node_modules/.bin/tsx "$SELECTOR_SCRIPT" < /dev/tty

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
INSTALL_OPENCLAW=false

if [[ "$SELECTED_FRAMEWORKS" == *"opencode"* ]]; then
    INSTALL_OPENCODE=true
fi
if [[ "$SELECTED_FRAMEWORKS" == *"claude"* ]]; then
    INSTALL_CLAUDE=true
fi
if [[ "$SELECTED_FRAMEWORKS" == *"openclaw"* ]]; then
    INSTALL_OPENCLAW=true
fi

# Exit if nothing selected
if [ "$INSTALL_OPENCODE" = "false" ] && [ "$INSTALL_CLAUDE" = "false" ] && [ "$INSTALL_OPENCLAW" = "false" ]; then
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
    curl -sSf "$SKILL_INSIGHT_BASE_URL/api/setup/opencode" -o "$OPENCODE_CONFIG_DIR/plugins/Witty-Skill-Insight.ts"
    cp "$OPENCODE_CONFIG_DIR/plugins/Witty-Skill-Insight.ts" "$HOME/.opencode/plugins/Witty-Skill-Insight.ts" 2>/dev/null || true
    echo "⏬ Downloading OpenCode Uploader..."
    curl -sSf "$SKILL_INSIGHT_BASE_URL/api/setup/opencode-uploader" -o "$HOME/.skill-insight/opencode_uploader_client.js"
    echo "⏬ Installing OpenCode commands..."
    mkdir -p "$OPENCODE_CONFIG_DIR/commands"
    curl -sSf "$SKILL_INSIGHT_BASE_URL/api/setup/opencode-commands/si-optimizer" -o "$OPENCODE_CONFIG_DIR/commands/si-optimizer.md"
    echo "⏬ Downloading OpenCode TUI Plugin..."
    curl -sSf "$SKILL_INSIGHT_BASE_URL/api/setup/opencode-tui" -o "$OPENCODE_CONFIG_DIR/plugins/Witty-Skill-Insight.tui.tsx"
    cp "$OPENCODE_CONFIG_DIR/plugins/Witty-Skill-Insight.tui.tsx" "$HOME/.opencode/plugins/Witty-Skill-Insight.tui.tsx" 2>/dev/null || true
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

if [ "$INSTALL_OPENCLAW" = "true" ]; then
    echo "⏬ Downloading OpenClaw Watcher..."
    curl -sSf "$SKILL_INSIGHT_BASE_URL/api/setup/openclaw-watcher" -o "$HOME/.skill-insight/openclaw_watcher_client.ts"
fi

# 4. Configure ~/.skill-insight/.env (Auto mode - no interaction)
SKILL_INSIGHT_CONFIG_FILE="$HOME/.skill-insight/.env"
FINAL_SHOW_TASK_STATS="true"
if [ -f "$SKILL_INSIGHT_CONFIG_FILE" ]; then
  EXISTING_SHOW_TASK_STATS=$(grep '^SKILL_INSIGHT_SHOW_TASK_STATS=' "$SKILL_INSIGHT_CONFIG_FILE" | head -n 1 | cut -d'=' -f2-)
  if [ -n "$EXISTING_SHOW_TASK_STATS" ]; then
    FINAL_SHOW_TASK_STATS="$EXISTING_SHOW_TASK_STATS"
  fi
fi

echo "⚙️  Updating configuration..."
touch "$SKILL_INSIGHT_CONFIG_FILE"
if [ -f "$SKILL_INSIGHT_CONFIG_FILE" ]; then
    cp "$SKILL_INSIGHT_CONFIG_FILE" "\${SKILL_INSIGHT_CONFIG_FILE}.bak"
    grep -v "^SKILL_INSIGHT_HOST=" "\${SKILL_INSIGHT_CONFIG_FILE}.bak" | grep -v "^SKILL_INSIGHT_API_KEY=" | grep -v "^SKILL_INSIGHT_SHOW_TASK_STATS=" | grep -v "^SKILL_INSIGHT_RETENTION_DAYS=" | grep -v "^SKILL_INSIGHT_OPENCODE_OTEL_ENABLE=" | grep -v "^SKILL_INSIGHT_OPENCODE_SPOOL_DIR=" | grep -v "^SKILL_INSIGHT_OPENCODE_UPLOADER=" | grep -v "^SKILL_INSIGHT_CLAUDE_OTEL_SPOOL_DIR=" | grep -v "^SKILL_INSIGHT_CLAUDE_OTEL_RAW_API_BODIES=" | grep -v "^SKILL_INSIGHT_MAX_TOOL_IO=" | grep -v "^SKILL_INSIGHT_MAX_EVENT_STRING=" | grep -v "^SKILL_INSIGHT_OPENCODE_UPLOAD_COOLDOWN_MS=" > "$SKILL_INSIGHT_CONFIG_FILE"
    rm "\${SKILL_INSIGHT_CONFIG_FILE}.bak"
fi
echo "SKILL_INSIGHT_HOST=$SKILL_INSIGHT_HOST" >> "$SKILL_INSIGHT_CONFIG_FILE"
echo "SKILL_INSIGHT_API_KEY=$SKILL_INSIGHT_API_KEY" >> "$SKILL_INSIGHT_CONFIG_FILE"
echo "SKILL_INSIGHT_SHOW_TASK_STATS=$FINAL_SHOW_TASK_STATS" >> "$SKILL_INSIGHT_CONFIG_FILE"
echo "SKILL_INSIGHT_RETENTION_DAYS=10" >> "$SKILL_INSIGHT_CONFIG_FILE"
echo "SKILL_INSIGHT_OPENCODE_OTEL_ENABLE=true" >> "$SKILL_INSIGHT_CONFIG_FILE"
echo "SKILL_INSIGHT_OPENCODE_SPOOL_DIR=$HOME/.skill-insight/otel_data/opencode" >> "$SKILL_INSIGHT_CONFIG_FILE"
echo "SKILL_INSIGHT_OPENCODE_UPLOADER=$HOME/.skill-insight/opencode_uploader_client.js" >> "$SKILL_INSIGHT_CONFIG_FILE"
echo "SKILL_INSIGHT_CLAUDE_OTEL_SPOOL_DIR=$HOME/.skill-insight/otel_data/claude" >> "$SKILL_INSIGHT_CONFIG_FILE"
echo "SKILL_INSIGHT_CLAUDE_OTEL_RAW_API_BODIES=1" >> "$SKILL_INSIGHT_CONFIG_FILE"
echo "SKILL_INSIGHT_MAX_TOOL_IO=4000" >> "$SKILL_INSIGHT_CONFIG_FILE"
echo "SKILL_INSIGHT_MAX_EVENT_STRING=20000" >> "$SKILL_INSIGHT_CONFIG_FILE"
echo "SKILL_INSIGHT_OPENCODE_UPLOAD_COOLDOWN_MS=15000" >> "$SKILL_INSIGHT_CONFIG_FILE"
echo "✅ Configuration updated at $SKILL_INSIGHT_CONFIG_FILE"
echo "   SKILL_INSIGHT_HOST=$SKILL_INSIGHT_HOST"
echo "   SKILL_INSIGHT_API_KEY=********"

# 6. Install Watcher Dependencies (only if OpenClaw watcher is selected)
if [ "$INSTALL_OPENCLAW" = "true" ]; then
    echo ""
    echo "📦 Installing watcher dependencies..."
    if command -v npm &> /dev/null; then
      cd "$HOME/.skill-insight"
      if [ ! -f "package.json" ]; then
        echo '{"name": "skill-insight-watcher", "version": "1.0.0", "type": "module", "dependencies": {}}' > package.json
      fi
      npm install chokidar --save 2>/dev/null
      echo "✅ Dependencies installed"
    else
      echo "⚠️  npm not found. Skipping dependency installation."
    fi
fi

# 6.5 Configure Claude Code official OTel logs
if [ "$INSTALL_CLAUDE" = "true" ]; then
    cat > "$HOME/.skill-insight/claude_otel_env.sh" << 'CLAUDE_OTEL_EOF'
# Skill-Insight Claude Code OpenTelemetry integration
unalias claude 2>/dev/null || true

_skill_insight_claude_load_env() {
  if [ -f "$HOME/.skill-insight/.env" ]; then
    set -a
    . "$HOME/.skill-insight/.env"
    set +a
  fi
}

claude() {
  _skill_insight_claude_load_env
  local _si_host="\${SKILL_INSIGHT_HOST:-127.0.0.1:3000}"
  case "$_si_host" in http://*|https://*) ;; *) _si_host="http://$_si_host" ;; esac
  _si_host="\${_si_host%/}"
  env \\
    CLAUDE_CODE_ENABLE_TELEMETRY=1 \\
    OTEL_LOGS_EXPORTER=otlp \\
    OTEL_METRICS_EXPORTER="\${OTEL_METRICS_EXPORTER:-none}" \\
    OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json \\
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT="$_si_host/api/ingest/otel/v1/logs" \\
    OTEL_EXPORTER_OTLP_HEADERS="x-witty-api-key=\${SKILL_INSIGHT_API_KEY:-}" \\
    OTEL_LOG_USER_PROMPTS=1 \\
    OTEL_LOG_TOOL_DETAILS=1 \\
    OTEL_LOG_RAW_API_BODIES="\${SKILL_INSIGHT_CLAUDE_OTEL_RAW_API_BODIES:-1}" \\
    claude "$@"
}
CLAUDE_OTEL_EOF
    SHELL_RC="$HOME/.zshrc"
    [ -f "$HOME/.bashrc" ] && SHELL_RC="$HOME/.bashrc"
    if [ -f "$SHELL_RC" ] && ! grep -q "claude_otel_env.sh" "$SHELL_RC"; then
        echo "" >> "$SHELL_RC"
        echo "# Skill-Insight Claude Code OTel" >> "$SHELL_RC"
        echo "source \\"$HOME/.skill-insight/claude_otel_env.sh\\"" >> "$SHELL_RC"
    fi
    echo "✅ Claude Code OTel env installed at $HOME/.skill-insight/claude_otel_env.sh"
    echo "   Restart your terminal or run: source $HOME/.skill-insight/claude_otel_env.sh"
    pkill -f "claude_watcher_client.ts" 2>/dev/null || true
    rm -f "$HOME/.skill-insight/claude_watcher_client.ts" "$HOME/.skill-insight/start_claude_watcher.sh" "$HOME/.skill-insight/stop_claude_watcher.sh" "$HOME/.skill-insight/claude_watcher.pid"
    echo "🧹 Removed legacy Claude session-file watcher if it was installed."
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
        cat > "$HOME/.skill-insight/start_openclaw_watcher.sh" << 'WATCHER_EOF'
#!/bin/bash
# Stop existing watcher if running
pkill -f "openclaw_watcher_client.ts" 2>/dev/null

# Start watcher in background
cd "$HOME/.skill-insight" && nohup npx -y tsx "$HOME/.skill-insight/openclaw_watcher_client.ts" > "$HOME/.skill-insight/logs/openclaw_watcher.log" 2>&1 &
echo $! > "$HOME/.skill-insight/openclaw_watcher.pid"
echo "OpenClaw watcher started with PID $(cat $HOME/.skill-insight/openclaw_watcher.pid)"
WATCHER_EOF
        chmod +x "$HOME/.skill-insight/start_openclaw_watcher.sh"
        echo "✅ OpenClaw watcher start script created"

        # OpenClaw Watcher Stop Script
        cat > "$HOME/.skill-insight/stop_openclaw_watcher.sh" << 'STOP_OPENCLAW_EOF'
#!/bin/bash
echo "Stopping OpenClaw watcher..."
pkill -f "openclaw_watcher_client.ts" 2>/dev/null
rm -f "$HOME/.skill-insight/openclaw_watcher.pid"
echo "OpenClaw watcher stopped"
STOP_OPENCLAW_EOF
        chmod +x "$HOME/.skill-insight/stop_openclaw_watcher.sh"
        echo "✅ OpenClaw watcher stop script created"
    fi

    # Combined Start Script - Dynamic generation
    cat > "$HOME/.skill-insight/start_watchers.sh" << 'WATCHER_HEADER'
#!/bin/bash
echo "Starting Skill-Insight watchers..."
WATCHER_HEADER

    if [ "$INSTALL_OPENCLAW" = "true" ]; then
        echo '"$HOME/.skill-insight/start_openclaw_watcher.sh"' >> "$HOME/.skill-insight/start_watchers.sh"
    fi

    echo 'echo "All watchers started!"' >> "$HOME/.skill-insight/start_watchers.sh"
    chmod +x "$HOME/.skill-insight/start_watchers.sh"
    echo "✅ Combined start script created"

    # Combined Stop Script - Dynamic generation
    cat > "$HOME/.skill-insight/stop_watchers.sh" << 'STOP_HEADER'
#!/bin/bash
echo "Stopping Skill-Insight watchers..."
STOP_HEADER

    if [ "$INSTALL_OPENCLAW" = "true" ]; then
        echo '"$HOME/.skill-insight/stop_openclaw_watcher.sh"' >> "$HOME/.skill-insight/stop_watchers.sh"
    fi

    echo 'echo "All watchers stopped!"' >> "$HOME/.skill-insight/stop_watchers.sh"
    chmod +x "$HOME/.skill-insight/stop_watchers.sh"
    echo "✅ Combined stop script created"
fi

# 8. Start Watchers Now
if [ "$NEEDS_WATCHER_SCRIPTS" = "true" ]; then
    echo ""
    echo "🚀 Starting telemetry watchers..."
    if command -v npx &> /dev/null; then
        "$HOME/.skill-insight/start_watchers.sh"
    else
        echo "⚠️  Node.js (npx) not found. Skipping watcher startup."
    fi
fi

# 10. Final Summary
echo ""
echo "🌟 Skill-Insight Telemetry: READY"
echo "------------------------------------------------"
echo "Installed Components:"
if [ "$INSTALL_OPENCODE" = "true" ]; then
    echo "  ✅ OpenCode Plugin: ~/.opencode/plugins/Witty-Skill-Insight.ts"
    echo "  ✅ OpenCode Command: ~/.config/opencode/commands/si-optimizer.md"
fi
if [ "$INSTALL_CLAUDE" = "true" ]; then
    echo "  ✅ Claude Code OTel: ~/.skill-insight/claude_otel_env.sh"
fi
if [ "$INSTALL_OPENCLAW" = "true" ]; then
    echo "  ✅ OpenClaw Watcher: ~/.skill-insight/openclaw_watcher_client.ts"
fi

if [ "$NEEDS_WATCHER_SCRIPTS" = "true" ]; then
    echo ""
    echo "Watcher Management:"
    echo "  Start all:    ~/.skill-insight/start_watchers.sh"
    echo "  Stop all:     ~/.skill-insight/stop_watchers.sh"
    if [ "$INSTALL_OPENCLAW" = "true" ]; then
        echo "  Start OpenClaw: ~/.skill-insight/start_openclaw_watcher.sh"
        echo "  Stop OpenClaw:  ~/.skill-insight/stop_openclaw_watcher.sh"
    fi
    echo "  Logs:         ~/.skill-insight/logs/"
fi

echo ""
echo "Usage:"
if [ "$INSTALL_OPENCODE" = "true" ]; then
    echo "  1. Run: opencode run 'hello'"
fi
if [ "$INSTALL_CLAUDE" = "true" ]; then
    echo "  2. Restart terminal, then run: claude"
fi
if [ "$INSTALL_OPENCLAW" = "true" ]; then
    echo "  3. OpenClaw will automatically monitor and upload telemetry"
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
        '$SKILL_INSIGHT_HOST = "' + hostParam + '"',
        '$SKILL_INSIGHT_BASE_URL = "' + baseUrl + '"',
        '$SKILL_INSIGHT_API_KEY = "' + apiKey + '"',
        '',
        'Write-Host "🚀 Fetching Skill-insight telemetry components from $SKILL_INSIGHT_BASE_URL..."',
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
        '$skillInsightDir = Join-Path $env:USERPROFILE ".skill-insight"',
        '$skillInsightLogsDir = Join-Path $skillInsightDir "logs"',
        '$opencodePluginsDir = Join-Path $env:USERPROFILE ".opencode\\plugins"',
        '$opencodeSkillsDir = Join-Path $env:USERPROFILE ".opencode\\skills"',
        '$claudeProjectsDir = Join-Path $env:USERPROFILE ".claude\\projects"',
        '$openclawAgentsDir = Join-Path $env:USERPROFILE ".openclaw\\agents"',
        '',
        'New-Item -ItemType Directory -Force -Path $skillInsightDir | Out-Null',
        'New-Item -ItemType Directory -Force -Path $skillInsightLogsDir | Out-Null',
        'New-Item -ItemType Directory -Force -Path $opencodePluginsDir | Out-Null',
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
        '    "    { name: \'OpenClaw\', value: \'openclaw\' }"',
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
        '    "    const resultFile = process.env.SELECTOR_RESULT_FILE || process.env.USERPROFILE + \'\\\\.skill-insight\\\\.selector_result\';"',
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
        '$INSTALL_OPENCLAW = $false',
        '',
        'if ($SELECTED_FRAMEWORKS -match "opencode") {',
        '    $INSTALL_OPENCODE = $true',
        '}',
        'if ($SELECTED_FRAMEWORKS -match "claude") {',
        '    $INSTALL_CLAUDE = $true',
        '}',
        'if ($SELECTED_FRAMEWORKS -match "openclaw") {',
        '    $INSTALL_OPENCLAW = $true',
        '}',
        '',
        '# Exit if nothing selected',
        'if (-not $INSTALL_OPENCODE -and -not $INSTALL_CLAUDE -and -not $INSTALL_OPENCLAW) {',
        '    Write-Host "⚠️  未选择任何框架组件，将跳过插件安装。"',
        '    Write-Host "   继续执行配置步骤..."',
        '    Write-Host ""',
        '}',
        '',
        '# 3. Download Components',
        'if ($INSTALL_OPENCODE) {',
        '    Write-Host "⏬ Downloading OpenCode Plugin..."',
        '    $opencodeConfigDir = if ($env:XDG_CONFIG_HOME) { Join-Path $env:XDG_CONFIG_HOME "opencode" } elseif ($env:APPDATA) { Join-Path $env:APPDATA "opencode" } else { Join-Path $homeDir ".config\\opencode" }',
        '    New-Item -ItemType Directory -Path (Join-Path $opencodeConfigDir "plugins") -Force | Out-Null',
        '    Remove-Item -Path (Join-Path $opencodeConfigDir "plugins\\Skill-Insight.ts") -Force -ErrorAction SilentlyContinue',
        '    Remove-Item -Path (Join-Path $opencodeConfigDir "plugins\\Witty-Skill-Insight.ts") -Force -ErrorAction SilentlyContinue',
        '    Remove-Item -Path (Join-Path $opencodePluginsDir "Skill-Insight.ts") -Force -ErrorAction SilentlyContinue',
        '    Remove-Item -Path (Join-Path $opencodePluginsDir "Witty-Skill-Insight.ts") -Force -ErrorAction SilentlyContinue',
        '    Invoke-WebRequest -Uri "$SKILL_INSIGHT_BASE_URL/api/setup/opencode" -OutFile (Join-Path $opencodeConfigDir "plugins\\Witty-Skill-Insight.ts")',
        '    Copy-Item (Join-Path $opencodeConfigDir "plugins\\Witty-Skill-Insight.ts") (Join-Path $opencodePluginsDir "Witty-Skill-Insight.ts") -Force -ErrorAction SilentlyContinue',
        '    Write-Host "⏬ Downloading OpenCode Uploader..."',
        '    Invoke-WebRequest -Uri "$SKILL_INSIGHT_BASE_URL/api/setup/opencode-uploader" -OutFile (Join-Path $homeDir ".skill-insight\\opencode_uploader_client.js")',
        '    Write-Host "⏬ Downloading OpenCode TUI Plugin..."',
        '    $tuiPluginPath = Join-Path $opencodeConfigDir "plugins\\Witty-Skill-Insight.tui.tsx"',
        '    Invoke-WebRequest -Uri "$SKILL_INSIGHT_BASE_URL/api/setup/opencode-tui" -OutFile $tuiPluginPath',
        '    Copy-Item $tuiPluginPath (Join-Path $opencodePluginsDir "Witty-Skill-Insight.tui.tsx") -Force -ErrorAction SilentlyContinue',
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
        'if ($INSTALL_OPENCLAW) {',
        '    Write-Host "⏬ Downloading OpenClaw Watcher..."',
        '    Invoke-WebRequest -Uri "$SKILL_INSIGHT_BASE_URL/api/setup/openclaw-watcher" -OutFile (Join-Path $skillInsightDir "openclaw_watcher_client.ts")',
        '}',
        '',
        '# 4. Configure ~/.skill-insight/.env (Auto mode - no interaction)',
        '$SKILL_INSIGHT_CONFIG_FILE = Join-Path $skillInsightDir ".env"',
        '',
        'Write-Host "⚙️  Updating configuration..."',
        'if (Test-Path $SKILL_INSIGHT_CONFIG_FILE) {',
        '    $existingContent = Get-Content $SKILL_INSIGHT_CONFIG_FILE',
        '    $existingShow = ($existingContent | Where-Object { $_ -match "^SKILL_INSIGHT_SHOW_TASK_STATS=" } | Select-Object -First 1)',
        '    $showValue = "true"',
        '    if ($existingShow) { $showValue = ($existingShow -split "=", 2)[1] }',
        '    $filteredContent = $existingContent | Where-Object { $_ -notmatch "^SKILL_INSIGHT_HOST=" -and $_ -notmatch "^SKILL_INSIGHT_API_KEY=" -and $_ -notmatch "^SKILL_INSIGHT_SHOW_TASK_STATS=" -and $_ -notmatch "^SKILL_INSIGHT_RETENTION_DAYS=" -and $_ -notmatch "^SKILL_INSIGHT_OPENCODE_OTEL_ENABLE=" -and $_ -notmatch "^SKILL_INSIGHT_OPENCODE_SPOOL_DIR=" -and $_ -notmatch "^SKILL_INSIGHT_OPENCODE_UPLOADER=" -and $_ -notmatch "^SKILL_INSIGHT_CLAUDE_OTEL_SPOOL_DIR=" -and $_ -notmatch "^SKILL_INSIGHT_CLAUDE_OTEL_RAW_API_BODIES=" -and $_ -notmatch "^SKILL_INSIGHT_MAX_TOOL_IO=" -and $_ -notmatch "^SKILL_INSIGHT_MAX_EVENT_STRING=" -and $_ -notmatch "^SKILL_INSIGHT_OPENCODE_UPLOAD_COOLDOWN_MS=" }',
        '    Set-Content -Path $SKILL_INSIGHT_CONFIG_FILE -Value $filteredContent',
        '} else {',
        '    New-Item -ItemType File -Path $SKILL_INSIGHT_CONFIG_FILE -Force | Out-Null',
        '    $showValue = "true"',
        '}',
        'Add-Content -Path $SKILL_INSIGHT_CONFIG_FILE -Value "SKILL_INSIGHT_HOST=$SKILL_INSIGHT_HOST"',
        'Add-Content -Path $SKILL_INSIGHT_CONFIG_FILE -Value "SKILL_INSIGHT_API_KEY=$SKILL_INSIGHT_API_KEY"',
        'Add-Content -Path $SKILL_INSIGHT_CONFIG_FILE -Value "SKILL_INSIGHT_SHOW_TASK_STATS=$showValue"',
        'Add-Content -Path $SKILL_INSIGHT_CONFIG_FILE -Value "SKILL_INSIGHT_RETENTION_DAYS=10"',
        'Add-Content -Path $SKILL_INSIGHT_CONFIG_FILE -Value "SKILL_INSIGHT_OPENCODE_OTEL_ENABLE=true"',
        'Add-Content -Path $SKILL_INSIGHT_CONFIG_FILE -Value "SKILL_INSIGHT_OPENCODE_SPOOL_DIR=$homeDir\\.skill-insight\\otel_data\\opencode"',
        'Add-Content -Path $SKILL_INSIGHT_CONFIG_FILE -Value "SKILL_INSIGHT_OPENCODE_UPLOADER=$homeDir\\.skill-insight\\opencode_uploader_client.js"',
        'Add-Content -Path $SKILL_INSIGHT_CONFIG_FILE -Value "SKILL_INSIGHT_CLAUDE_OTEL_SPOOL_DIR=$homeDir\\.skill-insight\\otel_data\\claude"',
        'Add-Content -Path $SKILL_INSIGHT_CONFIG_FILE -Value "SKILL_INSIGHT_CLAUDE_OTEL_RAW_API_BODIES=1"',
        'Add-Content -Path $SKILL_INSIGHT_CONFIG_FILE -Value "SKILL_INSIGHT_MAX_TOOL_IO=4000"',
        'Add-Content -Path $SKILL_INSIGHT_CONFIG_FILE -Value "SKILL_INSIGHT_MAX_EVENT_STRING=20000"',
        'Add-Content -Path $SKILL_INSIGHT_CONFIG_FILE -Value "SKILL_INSIGHT_OPENCODE_UPLOAD_COOLDOWN_MS=15000"',
        'Write-Host "✅ Configuration updated at $SKILL_INSIGHT_CONFIG_FILE"',
        'Write-Host "   SKILL_INSIGHT_HOST=$SKILL_INSIGHT_HOST"',
        'Write-Host "   SKILL_INSIGHT_API_KEY=********"',
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
        '  $envFile = Join-Path $env:USERPROFILE ".skill-insight\\.env"',
        '  if (Test-Path $envFile) {',
        '    Get-Content $envFile | ForEach-Object {',
        '      if ($_ -match "^([^#=]+)=(.*)$") { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], "Process") }',
        '    }',
        '  }',
        '  $siHost = if ($env:SKILL_INSIGHT_HOST) { $env:SKILL_INSIGHT_HOST } else { "127.0.0.1:3000" }',
        '  if ($siHost -notmatch "^https?://") { $siHost = "http://$siHost" }',
        '  $siHost = $siHost.TrimEnd("/")',
        '  $env:CLAUDE_CODE_ENABLE_TELEMETRY = "1"',
        '  $env:OTEL_LOGS_EXPORTER = "otlp"',
        '  if (-not $env:OTEL_METRICS_EXPORTER) { $env:OTEL_METRICS_EXPORTER = "none" }',
        '  $env:OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = "http/json"',
        '  $env:OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = "$siHost/api/ingest/otel/v1/logs"',
        '  $env:OTEL_EXPORTER_OTLP_HEADERS = "x-witty-api-key=$($env:SKILL_INSIGHT_API_KEY)"',
        '  $env:OTEL_LOG_USER_PROMPTS = "1"',
        '  $env:OTEL_LOG_TOOL_DETAILS = "1"',
        '  if (-not $env:SKILL_INSIGHT_CLAUDE_OTEL_RAW_API_BODIES) { $env:SKILL_INSIGHT_CLAUDE_OTEL_RAW_API_BODIES = "1" }',
        '  $env:OTEL_LOG_RAW_API_BODIES = $env:SKILL_INSIGHT_CLAUDE_OTEL_RAW_API_BODIES',
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
        '    if (-not (Test-Path $PROFILE) -or -not ((Get-Content $PROFILE -Raw) -match "claude_otel_env.ps1")) {',
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
        '$skillInsightDir = Join-Path $env:USERPROFILE ".skill-insight"',
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
        '    Write-Host "  ✅ OpenCode Plugin: ~/.opencode/plugins/Witty-Skill-Insight.ts"',
        '}',
        'if ($INSTALL_CLAUDE) {',
        '    Write-Host "  ✅ Claude Code OTel: ~/.skill-insight/claude_otel_env.ps1"',
        '}',
        'if ($INSTALL_OPENCLAW) {',
        '    Write-Host "  ✅ OpenClaw Watcher: ~/.skill-insight/openclaw_watcher_client.ts"',
        '}',
        '',
        'if ($NEEDS_WATCHER_SCRIPTS) {',
        '    Write-Host ""',
        '    Write-Host "Watcher Management:"',
        '    Write-Host "  Start all:    ~/.skill-insight/start_watchers.ps1"',
        '    Write-Host "  Stop all:     ~/.skill-insight/stop_watchers.ps1"',
        '    if ($INSTALL_OPENCLAW) {',
        '        Write-Host "  Start OpenClaw: ~/.skill-insight/start_openclaw_watcher.ps1"',
        '        Write-Host "  Stop OpenClaw:  ~/.skill-insight/stop_openclaw_watcher.ps1"',
        '    }',
        '    Write-Host "  Logs:         ~/.skill-insight/logs/"',
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
        'if ($INSTALL_OPENCLAW) {',
        '    Write-Host "  3. OpenClaw will automatically monitor and upload telemetry"',
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
