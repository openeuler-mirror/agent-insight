#!/bin/bash
source "$(dirname "$0")/_lib.sh"

echo "=== OOM Killer 排查 $(date) ==="

if [ -z "${VMCORE_PATH:-}" ]; then
    echo "错误: 请设置 VMCORE_PATH 环境变量"
    exit 1
fi

echo "--- Check 1: 搜索 OOM 相关日志 ---"
output=$(crash "$VMCORE_PATH" /usr/lib/debug/lib/modules/$(uname -r)/vmlinux 2>/dev/null <<'EOF' | grep -i -A 10 -B 5 "out of memory\|oom-killer\|kill process"
log
quit
EOF
)

if echo "$output" | grep -qi "out of memory\|oom-killer"; then
    hit "OOM_KILLER" "$output"
    echo ""
    echo "--- 时间线 ---"
    timeline "oom\|out of memory" 24
else
    miss "OOM_KILLER" "未发现 OOM 相关日志"
fi

echo "--- Check 2: 检查 OOM 上下文 ---"
oom_context=$(crash "$VMCORE_PATH" /usr/lib/debug/lib/modules/$(uname -r)/vmlinux 2>/dev/null <<'EOF' 2>&1
oom
quit
EOF
)

if echo "$oom_context" | grep -q "OOM context\|oom_victim"; then
    hit "OOM_CONTEXT" "$oom_context"
else
    miss "OOM_CONTEXT" "未发现 OOM 上下文信息"
fi

echo "--- Check 3: 检查内存压力 ---"
mem_info=$(crash "$VMCORE_PATH" /usr/lib/debug/lib/modules/$(uname -r)/vmlinux 2>/dev/null <<'EOF' 2>&1
kmem -i
quit
EOF
)

if echo "$mem_info" | grep -q "PAGES\|TOTAL\|USED\|FREE"; then
    if echo "$mem_info" | awk '/Free/ {if ($3 < 100000) exit 1}'; then
        hit "MEMORY_PRESSURE" "内存不足: $(echo "$mem_info" | head -20)"
    else
        miss "MEMORY_PRESSURE" "内存充足"
    fi
else
    warn "MEMORY_INFO_UNAVAILABLE" "无法获取内存信息"
fi

dump_json