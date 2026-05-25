#!/bin/bash
source "$(dirname "$0")/_lib.sh"

echo "=== Vmcore 信息采集 $(date) ==="

if [ -z "${VMCORE_PATH:-}" ]; then
    echo "错误: 请设置 VMCORE_PATH 环境变量指向 vmcore 文件"
    echo "用法: VMCORE_PATH=/path/to/vmcore sudo -E bash scripts/collect.sh"
    exit 1
fi

if [ ! -f "$VMCORE_PATH" ]; then
    echo "错误: vmcore 文件不存在: $VMCORE_PATH"
    exit 1
fi

if ! command -v crash &>/dev/null; then
    echo "错误: 未找到 crash 工具,请先安装 kernel-debuginfo 和 crash"
    exit 1
fi

record "vmcore_info" "INFO" "ls -lh $VMCORE_PATH"
record "vmcore_size" "INFO" "$(stat -c%s "$VMCORE_PATH" 2>/dev/null || stat -f%z "$VMCORE_PATH")"
record "crash_version" "INFO" "$(crash --version 2>&1)"

if [ "${1:-}" = "--full" ]; then
    record "full_dmesg" "INFO" "$(dmesg -T 2>/dev/null | tail -500)"
    record "full_journal" "INFO" "$(journalctl --since '24 hours ago' --no-pager 2>/dev/null | tail -1000)"
fi

dump_json