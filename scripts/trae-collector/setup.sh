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
echo "⚠️  后续步骤:"
echo "   1. 重启 TRAE IDE 使 Hook 生效"
echo "   2. 日志查看（分两部分）："
echo "      - TRAE IDE Hook 日志：TRAE 设置 → Hooks → 运行日志"
echo "      - 插件日志：输出面板 (Ctrl+Shift+U) → 选择 Agent Insight 频道"
echo "   3. 配置扩展连接信息：打开 Agent Insight TRAE Collector 扩展设置 →"
echo "      填写 Host（如 http://localhost:3000）与 Api Key（看板 Agent 详情页获取）"
