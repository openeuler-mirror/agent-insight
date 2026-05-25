#!/usr/bin/env bash
# validate_skill.sh — L1/L2 结构合规验证
# 用法: ./validate_skill.sh <skill_dir>
#
# 退出码: 0=全部通过, 1=有检查项失败

set -uo pipefail

SKILL_DIR="${1:-}"
if [[ -z "$SKILL_DIR" || ! -d "$SKILL_DIR" ]]; then
    echo "用法: $0 <skill_dir>"
    exit 1
fi

PASS=0
FAIL=0
WARN=0

pass() { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }
warn() { echo "  ⚠️  $1"; WARN=$((WARN+1)); }

echo ""
echo "════════════════════════════════════════"
echo "  Skill 合规验证: $(basename "$SKILL_DIR")"
echo "════════════════════════════════════════"

# ── L1: 结构合规 ──────────────────────────
echo ""
echo "【L1】结构合规"

# S-01: SKILL.md 存在
SKILL_MD="$SKILL_DIR/SKILL.md"
if [[ -f "$SKILL_MD" ]]; then
    pass "S-01: SKILL.md 存在"
else
    fail "S-01: SKILL.md 不存在"
    echo ""
    echo "结果: $PASS 通过 / $FAIL 失败 / $WARN 警告"
    exit 1  # 没有 SKILL.md 后续检查无意义
fi

# S-02: YAML frontmatter 可解析（检查 --- 分隔符）
FRONTMATTER=$(awk '/^---/{c++; if(c==2) exit} c==1' "$SKILL_MD")
if [[ -n "$FRONTMATTER" ]]; then
    pass "S-02: YAML frontmatter 存在"
else
    fail "S-02: 未找到 YAML frontmatter（需要 --- 包裹）"
fi

# S-03: name 字段存在且格式合法（kebab-case, ≤64字符）
NAME=$(echo "$FRONTMATTER" | grep -E '^name:' | sed 's/name:[[:space:]]*//' | tr -d '"' | tr -d "'" | head -1)
if [[ -z "$NAME" ]]; then
    fail "S-03: frontmatter 中缺少 name 字段"
elif [[ ${#NAME} -gt 64 ]]; then
    fail "S-03: name 超过 64 字符（当前: ${#NAME}字符）"
elif ! echo "$NAME" | grep -qE '^[a-z0-9][a-z0-9-]*[a-z0-9]$'; then
    fail "S-03: name 不符合 kebab-case 格式（'$NAME'）"
else
    pass "S-03: name 格式合法（'$NAME'）"
fi

# S-04: description 长度 100~1024
DESC=$(echo "$FRONTMATTER" | awk '/^description:/{found=1; next} found && /^[^ ]/{found=0} found{print}' | tr -d '\n' | sed 's/^[[:space:]]*//')
DESC_LEN=${#DESC}
if [[ $DESC_LEN -lt 100 ]]; then
    fail "S-04: description 过短（${DESC_LEN}字符，要求 ≥100）"
elif [[ $DESC_LEN -gt 1024 ]]; then
    fail "S-04: description 过长（${DESC_LEN}字符，要求 ≤1024）"
else
    pass "S-04: description 长度合法（${DESC_LEN}字符）"
fi

BODY=$(awk '/^---/{c++} c>=2{print}' "$SKILL_MD")

# S-05: 行数 ≤ 500
LINE_COUNT=$(wc -l < "$SKILL_MD")
if [[ $LINE_COUNT -le 500 ]]; then
    pass "S-05: SKILL.md 行数合规（${LINE_COUNT}行）"
else
    fail "S-05: SKILL.md 超过 500 行（${LINE_COUNT}行）"
fi

# ── L2: 内容质量 ─────────────────────────
echo ""
echo "【L2】内容质量"

# S-06: scripts/*.sh 语法检查
SCRIPTS_DIR="$SKILL_DIR/scripts"
if [[ -d "$SCRIPTS_DIR" ]]; then
    SCRIPT_FILES=$(find "$SCRIPTS_DIR" -name "*.sh" 2>/dev/null)
    if [[ -z "$SCRIPT_FILES" ]]; then
        warn "S-06: scripts/ 目录存在但无 .sh 文件"
    else
        ALL_PASS=true
        while IFS= read -r script; do
            if bash -n "$script" 2>/dev/null; then
                pass "S-06: 脚本语法正常（$(basename "$script")）"
            else
                fail "S-06: 脚本语法错误（$(basename "$script")）"
                ALL_PASS=false
            fi
        done <<< "$SCRIPT_FILES"
    fi
else
    warn "S-06: 无 scripts/ 目录（故障诊断 Skill 通常应有排查脚本）"
fi

# S-07: 参考文件说明章节存在
if echo "$BODY" | grep -qE '参考文件|Reference'; then
    pass "S-07: 参考文件说明章节存在"
else
    warn "S-07: 未找到参考文件说明章节"
fi

# ── 汇总 ─────────────────────────────────
echo ""
echo "════════════════════════════════════════"
TOTAL=$((PASS + FAIL + WARN))
echo "  结果: ${PASS}✅ 通过  ${FAIL}❌ 失败  ${WARN}⚠️ 警告  (共${TOTAL}项)"
echo "════════════════════════════════════════"
echo ""

if [[ $FAIL -gt 0 ]]; then
    exit 1
fi
exit 0
