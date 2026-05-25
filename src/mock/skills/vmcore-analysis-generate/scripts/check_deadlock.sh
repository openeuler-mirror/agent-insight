#!/bin/bash
source "$(dirname "$0")/_lib.sh"

echo "=== Deadlock 排查 $(date) ==="

if [ -z "${VMCORE_PATH:-}" ]; then
    echo "错误: 请设置 VMCORE_PATH 环境变量"
    exit 1
fi

echo "--- Check 1: 检查进程状态 ---"
proc_status=$(crash "$VMCORE_PATH" /usr/lib/debug/lib/modules/$(uname -r)/vmlinux 2>/dev/null <<'EOF' 2>&1
ps
quit
EOF
)

uninterruptible_count=$(echo "$proc_status" | grep -c "UN")

if [ "$uninterruptible_count" -gt 1 ]; then
    hit "DEADLOCK_SUSPECT" "发现 $uninterruptible_count 个 TASK_UNINTERRUPTIBLE 进程"
    echo ""
    echo "等待进程列表:"
    echo "$proc_status" | grep "UN"
    echo ""
    echo "--- 时间线 ---"
    timeline "lock\|semaphore\|mutex" 24
else
    miss "DEADLOCK_SUSPECT" "未发现异常进程状态"
fi

echo "--- Check 2: 检查锁持有情况 ---"
lock_info=$(crash "$VMCORE_PATH" /usr/lib/debug/lib/modules/$(uname -r)/vmlinux 2>/dev/null <<'EOF' 2>&1
foreach bt
quit
EOF
)

if echo "$lock_info" | grep -q "spin_lock\|mutex_lock\|rwlock"; then
    hit "LOCK_HOLDING" "发现锁持有: $(echo "$lock_info" | grep -i lock | head -10)"
else
    miss "LOCK_HOLDING" "未发现锁持有异常"
fi

echo "--- Check 3: 检查锁等待链 ---"
blocked_chain=$(crash "$VMCORE_PATH" /usr/lib/debug/lib/modules/$(uname -r)/vmlinux 2>/dev/null <<'EOF' 2>&1
foreach bt | grep -A 5 -B 5 "down\|wait\|schedule"
quit
EOF
)

if [ -n "$blocked_chain" ]; then
    hit "BLOCKED_CHAIN" "发现等待链: $(echo "$blocked_chain" | head -20)"
else
    miss "BLOCKED_CHAIN" "未发现等待链"
fi

dump_json