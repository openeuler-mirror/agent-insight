#!/bin/bash
source "$(dirname "$0")/_lib.sh"

echo "=== NULL Pointer Dereference 排查 $(date) ==="

if [ -z "${VMCORE_PATH:-}" ]; then
    echo "错误: 请设置 VMCORE_PATH 环境变量"
    exit 1
fi

echo "--- Check 1: 检查调用栈中的 NULL 指针 ---"
backtrace=$(crash "$VMCORE_PATH" /usr/lib/debug/lib/modules/$(uname -r)/vmlinux 2>/dev/null <<'EOF' 2>&1
bt
quit
EOF
)

if echo "$backtrace" | grep -qi "null\|BUG\|invalid"; then
    hit "NULL_PTR_BT" "调用栈含 NULL 指针引用: $(echo "$backtrace" | head -30)"
    echo ""
    echo "--- 时间线 ---"
    timeline "null\|BUG\|invalid" 24
else
    miss "NULL_PTR_BT" "调用栈未发现 NULL 指针迹象"
fi

echo "--- Check 2: 检查 RIP 寄存器 ---"
rip_info=$(crash "$VMCORE_PATH" /usr/lib/debug/lib/modules/$(uname -r)/vmlinux 2>/dev/null <<'EOF' 2>&1
dis -r $(bt | grep "RIP" | awk '{print $4}')
quit
EOF
)

if [ -n "$rip_info" ]; then
    if echo "$rip_info" | grep -q "mov\|lea\|call"; then
        hit "RIP_NULL_CHECK" "RIP 指向指令: $rip_info"
    else
        miss "RIP_NULL_CHECK" "RIP 位置正常"
    fi
else
    warn "RIP_UNAVAILABLE" "无法获取 RIP 信息"
fi

echo "--- Check 3: 检查指针值 ---"
ptr_check=$(crash "$VMCORE_PATH" /usr/lib/debug/lib/modules/$(uname -r)/vmlinux 2>/dev/null <<'EOF' 2>&1
bt | grep "RIP" | awk '{print $4}' | head -1
struct struct_name $(bt | grep -A 1 "RIP" | awk '{print $4}')
quit
EOF
)

if [ -n "$ptr_check" ]; then
    hit "PTR_VALUE" "指针检查: $ptr_check"
else
    miss "PTR_VALUE" "未发现指针值异常"
fi

dump_json