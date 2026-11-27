# 产出目录结构模板

生成排查型 Skill 时，按以下结构输出文件。

## 目录结构

```
{skill_name}/
  SKILL.md                    # 排查骨架（<500行）
  scripts/
    collect.sh                # 信息采集（自包含脚本）
    check_{fault_mode_1}.sh   # 故障模式排查脚本（自包含）
    check_{fault_mode_2}.sh
    ...
  references/
    {fault_mode_1}.md         # 故障模式 1 的子场景与排查建议
    {fault_mode_2}.md         # 故障模式 2 的子场景与排查建议
    ...
    pattern_detail.md         # 仅案例归纳场景：归纳细节
    failure_cases.yaml        # 仅案例归纳场景：原始案例存档
```

## 文件生成顺序

1. 生成 `scripts/collect.sh`（信息采集）
2. 生成决策树 YAML（中间产物，不输出给用户）
3. 从决策树转换生成 `references/{fault_mode}.md`（子场景文档）
4. 从决策树转换生成 `scripts/check_*.sh`（排查脚本）
5. 从决策树转换生成 `SKILL.md`（排查骨架）
6. 按需生成 pattern_detail.md / failure_cases.yaml

## 脚本自包含原则

所有脚本**不依赖外部文件**，可单独执行。辅助函数从 `templates/fault-diagnosis/_lib.sh` 按需选取，直接内联在脚本头部。

内联规则：
- 仅内联脚本实际调用的函数，不全量复制
- `collect.sh` 通常只需 `record` + `dump_json`
- `check_*.sh` 通常需要 `run_cmd` + `record` + `hit` + `miss` + `dump_json`
- `timeline` 和 `has_cmd` 仅在脚本确实调用时才内联

## 脚本拆分策略

- 按排查层级拆：如网络故障按 OSI 层拆（physical/datalink/network/transport）
- 按安全类别拆：如安全故障按类别拆（auth/permissions/firewall/audit）
- 按系统组件拆：如 OOM 按用户态/内核态拆
- 每个脚本覆盖 2-4 个相关检查步骤，不要一个步骤一个脚本

## collect.sh 结构

```bash
#!/bin/bash
set -uo pipefail

# --- 内联辅助函数 ---
DIAG_RESULTS=()
record() {
    local check="$1" status="$2" detail="$3" ts
    ts=$(date -Iseconds 2>/dev/null || date "+%Y-%m-%dT%H:%M:%S")
    detail=$(printf '%s' "$detail" | head -20 | tr '\n' '|' | tr -d '\r\t')
    detail=$(printf '%s' "$detail" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
    check=$(printf '%s' "$check" | tr -d '\r\t' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
    ts=$(printf '%s' "$ts" | tr -d '\r\t' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
    DIAG_RESULTS+=("{\"check\":\"$check\",\"status\":\"$status\",\"detail\":\"$detail\",\"time\":\"$ts\"}")
}
dump_json() {
    echo "["; local first=true
    for r in "${DIAG_RESULTS[@]}"; do $first && first=false || echo ","; echo "  $r"; done
    echo "]"
}
# --- 辅助函数结束 ---

echo "=== 信息采集 $(date) ==="

# --- 通用采集（所有故障域共用）---
record "sysinfo" "INFO" "$(uname -a)"
record "os_release" "INFO" "$(cat /etc/os-release 2>/dev/null)"
record "uptime" "INFO" "$(uptime)"
record "memory_overview" "INFO" "$(free -h)"
record "disk_overview" "INFO" "$(df -h)"
record "top_processes" "INFO" "$(ps aux --sort=-%mem | head -15)"
record "recent_errors" "INFO" "$(journalctl -p err --since '1 hour ago' --no-pager 2>/dev/null | tail -30)"

# --- 域特定采集（Generator 填充）---
# {根据故障域生成}

if [ "${1:-}" = "--full" ]; then
    # 完整采集模式（兜底时使用）
    record "full_dmesg" "INFO" "$(dmesg -T 2>/dev/null | tail -200)"
    record "full_journal" "INFO" "$(journalctl --since '24 hours ago' --no-pager 2>/dev/null | tail -500)"
    # {域特定完整采集}
fi

dump_json
```

## check_*.sh 结构

```bash
#!/bin/bash
set -uo pipefail

# --- 内联辅助函数（按需选取） ---
DIAG_RESULTS=()
run_cmd() {
    local desc="$1"; shift; local output rc
    output=$(timeout 10 "$@" 2>&1); rc=$?; echo "$output"; return $rc
}
record() {
    local check="$1" status="$2" detail="$3" ts
    ts=$(date -Iseconds 2>/dev/null || date "+%Y-%m-%dT%H:%M:%S")
    detail=$(printf '%s' "$detail" | head -20 | tr '\n' '|' | tr -d '\r\t')
    detail=$(printf '%s' "$detail" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
    check=$(printf '%s' "$check" | tr -d '\r\t' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
    ts=$(printf '%s' "$ts" | tr -d '\r\t' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
    DIAG_RESULTS+=("{\"check\":\"$check\",\"status\":\"$status\",\"detail\":\"$detail\",\"time\":\"$ts\"}")
}
hit()  { record "$1" "HIT"  "$2"; }
miss() { record "$1" "MISS" "$2"; }
dump_json() {
    echo "["; local first=true
    for r in "${DIAG_RESULTS[@]}"; do $first && first=false || echo ","; echo "  $r"; done
    echo "]"
}
# --- 辅助函数结束 ---

echo "=== {故障模式名}排查 $(date) ==="

# --- Check: {检查项描述} ---
output=$(run_cmd "{描述}" {命令1} {参数})
if {判断条件}; then
    hit "{检查项名}" "$output"
else
    miss "{检查项名}" "$output"
fi

# --- Check: {下一个检查项} ---
# ...

dump_json
```

## references/{fault_mode}.md 结构

```markdown
# {故障模式名称}

## 概述
{该故障模式的机制简述，1-2 行}

## 子场景

### 子场景 1: {子场景名称}
- **典型表现**: {该子场景特有的症状}
- **触发条件**: {导致该子场景的常见原因}
- **排查建议**:
  1. {具体排查步骤与命令}
  2. {进一步确认方法}
- **修复建议**: {临时缓解 / 根因修复}

### 子场景 2: {子场景名称}
...

## 关联故障
- 与 {其他故障模式} 的区分: {关键区分点}
- 可能的连锁故障: {该模式可能引发的下游问题}
```

生成原则：
- 每个故障模式 2-5 个子场景
- 排查建议包含具体命令和预期输出
- 修复建议区分临时缓解与根因修复
- 关联故障帮助 Agent 在未命中时切换方向
