#!/bin/bash
# Copyright (c) 2026 Huawei Technologies Co., Ltd.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

source "$(dirname "$0")/_lib.sh"

echo "=== Kernel Panic 排查 $(date) ==="

if [ -z "${VMCORE_PATH:-}" ]; then
    echo "错误: 请设置 VMCORE_PATH 环境变量"
    exit 1
fi

echo "--- Check 1: 检查 panic 信息 ---"
panic_info=$(crash "$VMCORE_PATH" /usr/lib/debug/lib/modules/$(uname -r)/vmlinux 2>/dev/null <<'EOF' 2>&1
sys
quit
EOF
)

if echo "$panic_info" | grep -qi "panic\|KERNEL: panic"; then
    hit "KERNEL_PANIC" "$panic_info"
    echo ""
    echo "--- 时间线 ---"
    timeline "panic\|Kernel panic" 24
else
    miss "KERNEL_PANIC" "未发现 panic 信息"
fi

echo "--- Check 2: 检查崩溃调用栈 ---"
backtrace=$(crash "$VMCORE_PATH" /usr/lib/debug/lib/modules/$(uname -r)/vmlinux 2>/dev/null <<'EOF' 2>&1
bt
quit
EOF
)

if echo "$backtrace" | grep -q "PID\|CPU"; then
    hit "PANIC_BACKTRACE" "崩溃调用栈: $(echo "$backtrace" | head -30)"
    echo ""
    echo "调用栈关键函数:"
    echo "$backtrace" | awk '/#[0-9]/ {print}' | head -20
else
    miss "PANIC_BACKTRACE" "无法获取调用栈"
fi

echo "--- Check 3: 检查 panic 原因 ---"
panic_log=$(crash "$VMCORE_PATH" /usr/lib/debug/lib/modules/$(uname -r)/vmlinux 2>/dev/null <<'EOF' 2>&1
log | grep -i panic
quit
EOF
)

if [ -n "$panic_log" ]; then
    hit "PANIC_REASON" "$panic_log"
else
    miss "PANIC_REASON" "未找到 panic 原因"
fi

dump_json