#!/bin/bash
# ============================================================================
# Agent Insight TRAE Collector — One-Click Installation
# Installs: Hook scripts + VS Code Extension (VSIX)
# Supports: trae-cn / trae / code CLI, or direct filesystem deployment
# ============================================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSIGHT_DIR="${AGENT_INSIGHT_DIR:-$HOME/.agent-insight}"
TRAE_HOOK_DIR="$INSIGHT_DIR/trae-hooks"
TRAE_CN_DIR="${HOME}/.trae-cn"

echo "=============================================="
echo " Agent Insight TRAE Collector - One-Click Install"
echo "=============================================="

# Step 1: Install Hook Scripts
echo ""
echo "[1/3] Installing hook scripts..."
bash "$SCRIPT_DIR/setup.sh"

# Step 2: Install VS Code Extension
echo ""
echo "[2/3] Installing VS Code Extension..."
VSIX=$(ls "$SCRIPT_DIR"/agent-insight-trae-collector-*.vsix 2>/dev/null | head -1)
if [ -z "$VSIX" ]; then
  echo "  [WARN] No VSIX file found. Build it first:"
  echo "         cd $SCRIPT_DIR && npm install && node scripts/build.js"
  echo "         Then re-run this script."
  exit 1
fi

echo "  Found VSIX: $(basename "$VSIX")"

# Try CLI first, fallback to direct deployment
INSTALLED=false

# Try trae-cn
if command -v trae-cn &>/dev/null; then
  echo "  Using: trae-cn"
  trae-cn --install-extension "$VSIX" --force && INSTALLED=true
fi

# Try trae
if ! $INSTALLED && command -v trae &>/dev/null; then
  echo "  Using: trae"
  trae --install-extension "$VSIX" --force && INSTALLED=true
fi

# If no TRAE CLI, deploy directly to filesystem
if ! $INSTALLED;
then
  echo "  No IDE CLI found, deploying directly to TRAE extensions directory..."
  
  EXT_DIR="$TRAE_CN_DIR-server/extensions"
  EXT_NAME="agent-insight.agent-insight-trae-collector-0.1.0"
  
  # Create and extract VSIX
  mkdir -p "$EXT_DIR/$EXT_NAME"
  unzip -o "$VSIX" -d "$EXT_DIR/$EXT_NAME" >/dev/null 2>&1
  
  # Move files from extension/ subdirectory to root
  if [ -d "$EXT_DIR/$EXT_NAME/extension" ]; then
    shopt -s dotglob
    mv "$EXT_DIR/$EXT_NAME/extension/"* "$EXT_DIR/$EXT_NAME/" 2>/dev/null
    shopt -u dotglob
    rm -rf "$EXT_DIR/$EXT_NAME/extension" 2>/dev/null
    rm -f "$EXT_DIR/$EXT_NAME/extension.vsixmanifest" 2>/dev/null
    rm -f "$EXT_DIR/$EXT_NAME/"[Content_Types].xml 2>/dev/null
  fi
  
  # Register in extensions.json
  EXT_JSON="$EXT_DIR/extensions.json"
  if [ -f "$EXT_JSON" ]; then
    python3 << PYEOF
import json, time
with open("$EXT_JSON") as f:
    exts = json.load(f)
ext_id = "agent-insight.agent-insight-trae-collector"
exts = [e for e in exts if e.get("identifier",{}).get("id","") != ext_id]
exts.append({
    "identifier": {"id": ext_id},
    "version": "0.1.0",
    "location": {
        "\$mid": 1,
        "fsPath": "$EXT_DIR/$EXT_NAME",
        "external": "file://$EXT_DIR/$EXT_NAME",
        "path": "$EXT_DIR/$EXT_NAME",
        "scheme": "file"
    },
    "relativeLocation": "$EXT_NAME",
    "metadata": {
        "installedTimestamp": int(time.time() * 1000),
        "pinned": True,
        "source": "vsix"
    }
})
with open("$EXT_JSON", "w") as f:
    json.dump(exts, f, indent=2)
PYEOF
    echo "  [OK] Extension registered in extensions.json"
  fi
  
  echo "  [OK] VSIX deployed to: $EXT_DIR/$EXT_NAME"
  INSTALLED=true
fi

if $INSTALLED; then
  echo "  [OK] VSIX installed successfully"
else
  echo "  [FAIL] VSIX installation failed"
  exit 1
fi

# Step 3: Configure .env
echo ""
echo "[3/3] Configuration..."
ENV_FILE="$INSIGHT_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
  touch "$ENV_FILE"
  echo "  Created $ENV_FILE"
fi

# Check host/key
HOST=$(grep AGENT_INSIGHT_HOST "$ENV_FILE" 2>/dev/null || echo "")
KEY=$(grep AGENT_INSIGHT_API_KEY "$ENV_FILE" 2>/dev/null || echo "")
if [ -z "$HOST" ] || [ -z "$KEY" ]; then
  echo "  [WARN] Please configure $ENV_FILE:"
  echo "         AGENT_INSIGHT_HOST=http://your-server:3000"
  echo "         AGENT_INSIGHT_API_KEY=your-api-key"
fi

echo ""
echo "Installation complete!"
echo ""
echo "Next steps:"
echo "  1. Restart TRAE IDE"
echo "  2. Start an Agent conversation"
echo "  3. Data will be auto-collected and uploaded"
