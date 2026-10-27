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

echo "=== Hardware Error 排查 $(date) ==="

if [ -z "${VMCORE_PATH:-}" ]; then
    echo "错误: 请设置 VMCORE_PATH 环境变量"
    exit 1
fi

echo "--- Check 1: 检查 MCE (Machine Check Exception) ---"
mce_info=$(crash "$VMCORE_PATH" /usr/lib/debug/lib/modules/$(uname -r)/vmlinux 2>/dev/null <<'EOF' 2>&1
mce
quit
EOF
)

if echo "$mce_info" | grep -q "MCE\|bank\|status\|MCi_STATUS"; then
    hit "MCE_DETECTED" "$mce_info"
    echo ""
    echo "--- 时间线 ---"
    timeline "MCE\|Machine Check" 24
else
    miss "MCE_DETECTED" "未发现 MCE 信息"
fi

echo "--- Check 2: 检查硬件错误日志 ---"
hw_error_log=$(crash "$VMCORE_PATH" /usr/lib/debug/lib/modules/$(uname -r)/vmlinux 2>/dev/null <<'EOF' 2>&1
log | grep -i "hardware\|mce\|machine check\|cpu\|memory error"
quit
EOF
)

if [ -n "$hw_error_log" ]; then
    hit "HW_ERROR_LOG" "$hw_error_log"
else
    miss "HW_ERROR_LOG" "未发现硬件错误日志"
fi

echo "--- Check 3: 检查 CPU 状态 ---"
cpu_status=$(crash "$VMCORE_PATH" /usr/lib/debug/lib/modules/$(uname -r)/vmlinux 2>/dev/null <<'EOF' 2>&1
sys -c
quit
EOF
)

if [ -n "$cpu_status" ]; then
    hit "CPU_STATUS" "CPU 状态: $cpu_status"
else
    miss "CPU_STATUS" "无法获取 CPU 状态"
fi

dump_json