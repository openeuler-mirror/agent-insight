#!/bin/bash
# _lib.sh — 排查型 Skill 通用诊断函数库
# 所有 check_*.sh 和 collect.sh 脚本 source 此文件
# 用法: source "$(dirname "$0")/_lib.sh"

set -uo pipefail

DIAG_RESULTS=()

# 带超时执行命令，捕获 stdout+stderr
run_cmd() {
    local desc="$1"; shift
    local output rc
    output=$(timeout 10 "$@" 2>&1); rc=$?
    echo "$output"
    return $rc
}

# 记录检查结果
record() {
    local check="$1" status="$2" detail="$3" ts
    ts=$(date -Iseconds 2>/dev/null || date "+%Y-%m-%dT%H:%M:%S")
    # 截断detail防止JSON过大
    detail=$(printf '%s' "$detail" | head -20 | tr '\n' '|' | tr -d '\r\t')
    detail=$(printf '%s' "$detail" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
    check=$(printf '%s' "$check" | tr -d '\r\t' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
    status=$(printf '%s' "$status" | tr -d '\r\t' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
    ts=$(printf '%s' "$ts" | tr -d '\r\t' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
    DIAG_RESULTS+=("{\"check\":\"$check\",\"status\":\"$status\",\"detail\":\"$detail\",\"time\":\"$ts\"}")
}

hit()  { record "$1" "HIT"  "$2"; }
miss() { record "$1" "MISS" "$2"; }
warn() { record "$1" "WARN" "$2"; }

# 输出所有结果为 JSON 数组
dump_json() {
    echo "["
    local first=true
    for r in "${DIAG_RESULTS[@]}"; do
        $first && first=false || echo ","
        echo "  $r"
    done
    echo "]"
}

# 时间线提取 — 苏格拉底追问的工具
# 用法: timeline "关键词" [回溯小时数，默认1]
# 从 journalctl/dmesg/var-log 多源提取，按时间排序去重
timeline() {
    local keyword="$1" hours="${2:-1}"
    local since
    # 兼容 GNU date 和 BSD date
    since=$(date -d "$hours hours ago" "+%Y-%m-%d %H:%M:%S" 2>/dev/null) || \
    since=$(date -v-${hours}H "+%Y-%m-%d %H:%M:%S" 2>/dev/null) || \
    since=""
    {
        if [ -n "$since" ]; then
            journalctl --since "$since" --no-pager 2>/dev/null | grep -i "$keyword"
        else
            journalctl -n 500 --no-pager 2>/dev/null | grep -i "$keyword"
        fi
        dmesg -T 2>/dev/null | grep -i "$keyword"
        grep -rh "$keyword" /var/log/messages /var/log/secure /var/log/syslog /var/log/audit/audit.log 2>/dev/null | tail -50
    } | sort -t' ' -k1,2 2>/dev/null | uniq
}

# 辅助：检查命令是否可用
has_cmd() { command -v "$1" &>/dev/null; }
