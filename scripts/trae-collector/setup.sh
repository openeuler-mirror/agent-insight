#!/bin/bash
set +e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK_SRC="$SCRIPT_DIR/hooks"
INSIGHT_DIR="${AGENT_INSIGHT_DIR:-$HOME/.agent-insight}"
TRAE_HOOK_DIR="$INSIGHT_DIR/trae-hooks"
TRAE_CN_DIR="${HOME}/.trae-cn"

echo "🚀 Agent Insight TRAE Collector — Setup"
echo "=========================================="

# Dependency check
if ! command -v python3 &>/dev/null; then
  echo "❌ python3 未安装。Hook 脚本依赖 python3 解析 JSON。"
  echo "   请安装: sudo apt install python3 或 brew install python3"
  exit 1
fi

# Step 1: Copy hook scripts
echo "📁 Installing hook scripts to $TRAE_HOOK_DIR..."
mkdir -p "$TRAE_HOOK_DIR/scripts" "$TRAE_HOOK_DIR/lib"
cp "$HOOK_SRC/scripts/"*.sh "$TRAE_HOOK_DIR/scripts/"
cp "$HOOK_SRC/lib/"*.sh "$TRAE_HOOK_DIR/lib/"
cp "$HOOK_SRC/hooks.json" "$TRAE_HOOK_DIR/hooks.json"
chmod +x "$TRAE_HOOK_DIR/scripts/"*.sh
echo "   ✅ Hook scripts installed"

# Step 2: Create TRAE hooks.json
echo "📝 Creating TRAE hook configuration..."
mkdir -p "$TRAE_CN_DIR"
# Escape special characters in HOOK_DIR for sed
ESCAPED_HOOK_DIR=$(echo "$TRAE_HOOK_DIR" | sed 's|/|\\/|g')
sed "s|__HOOK_DIR__|$ESCAPED_HOOK_DIR|g" \
  "$HOOK_SRC/hooks.json" > "$TRAE_CN_DIR/hooks.json"
echo "   ✅ TRAE hooks.json created at $TRAE_CN_DIR/hooks.json"

# Step 3: Ensure spool directory
echo "📂 Ensuring spool directories..."
mkdir -p "$INSIGHT_DIR/otel_data/trae"
mkdir -p "$INSIGHT_DIR/logs"
echo "   ✅ Spool directory: $INSIGHT_DIR/otel_data/trae"

# Step 4: Cleanup old spool data (>7 days)
echo "🧹 Cleaning old spool data (>7 days)..."
find "$INSIGHT_DIR/otel_data/trae" -maxdepth 2 -type d -mtime +7 -exec rm -rf {} \; 2>/dev/null || true
echo "   ✅ Old spool cleaned"

echo ""
echo "🎉 Setup complete!"
echo ""
echo "📋 Summary:"
echo "   Hook scripts:  $TRAE_HOOK_DIR/"
echo "   TRAE config:   $TRAE_CN_DIR/hooks.json"
echo "   Spool dir:     $INSIGHT_DIR/otel_data/trae"
echo ""
echo "⚠️  Next steps:"
echo "   1. Restart TRAE IDE for hooks to take effect"
echo "   2. Check hook logs in TRAE: Settings → Hooks → 运行日志"
echo "   3. The VS Code Extension handles: "
echo "      - 上传 Spool 数据到服务端"
echo "      - LLM 模型/Token 信息采集 (如可用)"
echo "      - 状态栏显示采集状态"
