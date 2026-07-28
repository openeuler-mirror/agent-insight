#!/bin/bash
# ============================================================================
# 查看 TRAE Hook 原始输入调试日志
# 启用方式: 在 ~/.agent-insight/.env 中添加 TRAE_DEBUG_RAW=1
# 日志位置: ~/.agent-insight/otel_data/trae/_debug_raw/<yyyy-mm-dd>.jsonl
#
# 用法:
#   bash scripts/trae-collector/hooks/scripts/debug-view.sh              # 查看今天的日志摘要
#   bash scripts/trae-collector/hooks/scripts/debug-view.sh 2026-07-25   # 查看指定日期
#   bash scripts/trae-collector/hooks/scripts/debug-view.sh --raw        # 显示完整原始 JSON
#   bash scripts/trae-collector/hooks/scripts/debug-view.sh --hook PreToolUse  # 按 hook 过滤
# ============================================================================
set -e

DEBUG_BASE="${AGENT_INSIGHT_DIR:-$HOME/.agent-insight}/otel_data/trae/_debug_raw"
DATE="${1:-$(date -u +%Y-%m-%d)}"
MODE="summary"
HOOK_FILTER=""

for arg in "$@"; do
  case "$arg" in
    --raw) MODE="raw" ;;
    --hook) HOOK_FILTER="$2"; shift ;;
    20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]) DATE="$arg" ;;
  esac
done

DEBUG_FILE="$DEBUG_BASE/$DATE.jsonl"

if [ ! -f "$DEBUG_FILE" ]; then
  echo "调试日志文件不存在: $DEBUG_FILE"
  echo ""
  echo "启用方法:"
  echo "  echo 'TRAE_DEBUG_RAW=1' >> ~/.agent-insight/.env"
  echo "  然后重启 TRAE"
  exit 1
fi

TOTAL=$(wc -l < "$DEBUG_FILE")

if [ "$MODE" = "raw" ]; then
  if [ -n "$HOOK_FILTER" ]; then
    grep "\"hook\":\"$HOOK_FILTER\"" "$DEBUG_FILE" | python3 -m json.tool 2>/dev/null || \
    grep "\"hook\":\"$HOOK_FILTER\"" "$DEBUG_FILE"
  else
    cat "$DEBUG_FILE"
  fi
  exit 0
fi

# summary mode
echo "=== TRAE Hook 原始输入 ($DATE) — 共 $TOTAL 条 ==="
echo ""

python3 -c "
import json, sys
from collections import Counter

hooks = Counter()
sessions = Counter()
tool_names = Counter()

for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try:
        ev = json.loads(line)
        h = ev.get('hook', '?')
        hooks[h] += 1
        sessions[ev.get('sessionID', '?')] += 1
        
        raw = ev.get('raw', {})
        tn = raw.get('tool_name', '')
        if tn: tool_names[tn] += 1
    except: pass

print('Hook 类型分布:')
for h, c in hooks.most_common():
    print(f'  {h}: {c}')

print(f'\nSession 数: {len(sessions)}')

if tool_names:
    print(f'\n工具调用分布:')
    for tn, c in tool_names.most_common(15):
        print(f'  {tn}: {c}')

print(f'\n查看原始数据: bash $0 $DATE --raw')
print(f'按 Hook 过滤:   bash $0 $DATE --hook PreToolUse --raw')
" < "$DEBUG_FILE"
