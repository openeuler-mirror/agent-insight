#!/bin/bash
source "$(dirname "$0")/_lib.sh"

echo "=== Stack Overflow 排查 $(date) ==="

if [ -z "${VMCORE_PATH:-}" ]; then
    echo "错误: 请设置 VMCORE_PATH 环境变量"
    exit 1
fi

echo "--- Check 1: 检查调用栈深度 ---"
backtrace=$(crash "$VMCORE_PATH" /usr/lib/debug/lib/modules/$(uname -r)/vmlinux 2>/dev/null <<'EOF' 2>&1
bt
quit
EOF
)

stack_depth=$(echo "$backtrace" | grep -c "^#")

if [ "$stack_depth" -gt 50 ]; then
    hit "STACK_OVERFLOW" "调用栈深度 $stack_depth 过大"
    echo ""
    echo "调用栈:"
    echo "$backtrace"
    echo ""
    echo "--- 时间线 ---"
    timeline "stack\|overflow" 24
else
    miss "STACK_OVERFLOW" "调用栈深度正常 ($stack_depth)"
fi

echo "--- Check 2: 检查栈边界 ---"
thread_info=$(crash "$VMCORE_PATH" /usr/lib/debug/lib/modules/$(uname -r)/vmlinux 2>/dev/null <<'EOF' 2>&1
struct thread_info $(bt | head -1 | awk '{print $2}')
quit
EOF
)

if [ -n "$thread_info" ]; then
    if echo "$thread_info" | grep -q "lowest_stack\|stack"; then
        hit "STACK_BOUNDARY" "栈边界: $thread_info"
    else
        miss "STACK_BOUNDARY" "栈边界正常"
    fi
else
    warn "THREAD_INFO_UNAVAILABLE" "无法获取 thread_info"
fi

echo "--- Check 3: 检查栈指针 ---"
sp_info=$(crash "$VMCORE_PATH" /usr/lib/debug/lib/modules/$(uname -r)/vmlinux 2>/dev/null <<'EOF' 2>&1
bt | grep "SP"
quit
EOF
)

if [ -n "$sp_info" ]; then
    hit "STACK_POINTER" "栈指针: $sp_info"
else
    miss "STACK_POINTER" "无法获取栈指针"
fi

dump_json