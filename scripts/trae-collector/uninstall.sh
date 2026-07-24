#!/bin/bash
set +e

INSIGHT_DIR="${AGENT_INSIGHT_DIR:-$HOME/.agent-insight}"
TRAE_HOOK_DIR="$INSIGHT_DIR/trae-hooks"
TRAE_CN_DIR="${HOME}/.trae-cn"

echo "🗑️  Agent Insight TRAE Collector — 卸载"
echo "=========================================="

# Confirm
read -p "是否确定卸载? (y/N): " CONFIRM
if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
  echo "取消卸载"
  exit 0
fi

# Step 1: Uninstall VS Code Extension
echo ""
echo "🔌 [1/5] 卸载 VS Code Extension..."
EXTENSION_ID="agent-insight.agent-insight-trae-collector"
TRAE_CMD=""
if command -v trae-cn &>/dev/null; then
  TRAE_CMD="trae-cn"
elif command -v trae &>/dev/null; then
  TRAE_CMD="trae"
elif command -v code &>/dev/null; then
  TRAE_CMD="code"
fi

if [ -n "$TRAE_CMD" ]; then
  if "$TRAE_CMD" --list-extensions 2>/dev/null | grep -q "$EXTENSION_ID"; then
    if "$TRAE_CMD" --uninstall-extension "$EXTENSION_ID" 2>/dev/null; then
      echo "  ✅ VSIX 已卸载: $EXTENSION_ID"
    else
      echo "  ❌ VSIX 卸载失败: $EXTENSION_ID"
    fi
  else
    echo "  ⚠️  未安装 VSIX: $EXTENSION_ID"
  fi
else
  echo "  ⚠️  未找到可用的 IDE 命令（trae-cn / trae / code）"
  echo "     请在 TRAE 插件市场中手动卸载 Agent Insight TRAE Collector"
fi

# Step 2: Remove hook scripts
echo ""
echo "📁 [2/5] 删除 Hook 脚本..."
if [ -d "$TRAE_HOOK_DIR" ]; then
  rm -rf "$TRAE_HOOK_DIR"
  echo "  ✅ 删除 Hook 脚本: $TRAE_HOOK_DIR"
fi

# Step 3: Remove TRAE hooks.json (only the agent-insight parts)
echo ""
echo "⚙️ [3/5] 删除 TRAE 配置..."
if [ -f "$TRAE_CN_DIR/hooks.json" ]; then
  # Check if the file contains our hooks (uses __HOOK_DIR__ placeholder or trae-hooks path)
  if grep -q "trae-hooks" "$TRAE_CN_DIR/hooks.json" 2>/dev/null; then
    rm -f "$TRAE_CN_DIR/hooks.json"
    echo "  ✅ 删除 TRAE 配置: $TRAE_CN_DIR/hooks.json"
  else
    echo "  ⚠️  hooks.json 包含非 agent-insight 配置，跳过删除"
  fi
fi

# Step 4: Remove checkpoint
echo ""
echo "📝 [4/5] 删除 checkpoint..."
CHECKPOINT="$INSIGHT_DIR/trae_uploader_checkpoint.json"
if [ -f "$CHECKPOINT" ]; then
  rm -f "$CHECKPOINT"
  echo "  ✅ 删除 checkpoint: $CHECKPOINT"
fi

# Step 5: Ask about spool data
echo ""
echo "🧹 [5/5] 清理 spool 数据..."
read -p "是否清理 spool 数据? (y/N): " CLEAN_SPOOL
if [ "$CLEAN_SPOOL" = "y" ] || [ "$CLEAN_SPOOL" = "Y" ]; then
  SPOOL_DIR="$INSIGHT_DIR/otel_data/trae"
  if [ -d "$SPOOL_DIR" ]; then
    rm -rf "$SPOOL_DIR"
    echo "  ✅ 删除 spool 数据: $SPOOL_DIR"
  fi
fi

echo ""
echo "🎉 卸载完成！"
echo ""
echo "📋 保留的内容:"
echo "  - 其他框架采集器 (不受影响)"
echo "  - ~/.agent-insight/.env (如存在)"
echo "  - ~/.agent-insight/logs/"
echo ""
echo "⚠️  如需完全清理，手动删除:"
echo "  - ~/.agent-insight/logs/trae_hook.log"
