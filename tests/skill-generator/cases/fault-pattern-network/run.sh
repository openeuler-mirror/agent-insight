#!/usr/bin/env bash
# run_test.sh — fault-pattern-network 测试运行脚本
#
# 用法:
#   ./run_test.sh                    # 使用默认输出目录
#   ./run_test.sh --output /tmp/out  # 指定输出目录
#   ./run_test.sh --validate-only /path/to/skill  # 只跑验证，不调用 opencode
#
# 依赖: opencode 已安装并在 PATH 中，skill-generator 已加载

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../../" && pwd)"
CASE_DIR="$SCRIPT_DIR"
INPUT_FILE="$CASE_DIR/input.md"
VALIDATE_SCRIPT="$PROJECT_ROOT/tests/skill-generator/validate_skill.sh"

# 默认输出目录
OUTPUT_DIR="$PROJECT_ROOT/tests/skill-generator/output/fault-pattern-network"
VALIDATE_ONLY=false
VALIDATE_ONLY_PATH=""

usage() {
    echo "用法: $0 [--output <dir>] [--validate-only <skill_dir>]"
    echo ""
    echo "  --output <dir>              指定生成 Skill 的输出目录（默认: $OUTPUT_DIR）"
    echo "  --validate-only <dir>       跳过 opencode 调用，只对已有目录做验证"
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --output) OUTPUT_DIR="$2"; shift 2 ;;
        --validate-only) VALIDATE_ONLY=true; VALIDATE_ONLY_PATH="$2"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) echo "未知参数: $1"; usage; exit 1 ;;
    esac
done

echo ""
echo "╔══════════════════════════════════════╗"
echo "║  Skill Generator 测试: fault-pattern-network ║"
echo "║  完整故障模式列表 → 排查 Skill       ║"
echo "╚══════════════════════════════════════╝"

# ── 仅验证模式 ───────────────────────────
if [[ "$VALIDATE_ONLY" == true ]]; then
    echo ""
    echo "⏭  跳过生成阶段（--validate-only 模式）"
    bash "$VALIDATE_SCRIPT" "$VALIDATE_ONLY_PATH"
    exit $?
fi

# ── Step 1: 前置检查 ─────────────────────
echo ""
echo "【Step 1】前置检查"

OPENCODE_BIN="$HOME/.opencode/bin/opencode"
if ! command -v opencode &>/dev/null && [[ ! -f "$OPENCODE_BIN" ]]; then
    echo "  ❌ opencode 未找到，请确认安装并在 PATH 中或在 $OPENCODE_BIN"
    exit 1
fi

if command -v opencode &>/dev/null; then
    OPENCODE_CMD="opencode"
else
    OPENCODE_CMD="$OPENCODE_BIN"
fi
echo "  ✅ opencode 已就绪: $OPENCODE_CMD"

if [[ ! -f "$INPUT_FILE" ]]; then
    echo "  ❌ 测试输入文件不存在: $INPUT_FILE"
    exit 1
fi
echo "  ✅ 测试输入文件: $INPUT_FILE"

# 检查 skill-generator 是否已加载
SKILL_PATH="$PROJECT_ROOT/.opencode/skills/skill-generator/SKILL.md"
if [[ ! -f "$SKILL_PATH" ]]; then
    echo "  ⚠️  skill-generator 未加载，正在执行 setup..."
    bash "$PROJECT_ROOT/tests/setup_skill_generator.sh"
fi
echo "  ✅ skill-generator 已加载"

# ── Step 2: 清理并准备输出目录 ───────────
echo ""
echo "【Step 2】准备输出目录: $OUTPUT_DIR"
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

# ── Step 3: 构造 Prompt 并调用 opencode ──
echo ""
echo "【Step 3】调用 opencode 生成 Skill"
echo "  （这可能需要 1-3 分钟）"
echo ""

INPUT_CONTENT=$(cat "$INPUT_FILE")

PROMPT="使用 skill-generator，基于以下故障模式列表生成排查 Skill（--auto 模式，全部采纳推荐选项，无需交互确认），输出目录为 ${OUTPUT_DIR}。

${INPUT_CONTENT}

请直接开始生成，完成后告知输出路径。"

echo "──── Prompt 预览 ────"
echo "$PROMPT" | head -5
echo "..."
echo "─────────────────────"
echo ""

# 执行 opencode，将输出实时显示
"$OPENCODE_CMD" run "$PROMPT"

# ── Step 4: 验证输出 ─────────────────────
echo ""
echo "【Step 4】验证输出"

# 找到生成的 Skill 目录（可能在 OUTPUT_DIR 下的子目录）
GENERATED_DIRS=$(find "$OUTPUT_DIR" -name "SKILL.md" -maxdepth 3 2>/dev/null | \
    xargs -I{} dirname {} | sort -u)

if [[ -z "$GENERATED_DIRS" ]]; then
    echo "  ❌ 未在 $OUTPUT_DIR 下找到生成的 SKILL.md"
    echo "  请检查 opencode 输出，或使用 --validate-only <实际路径> 手动验证"
    exit 1
fi

EXIT_CODE=0
while IFS= read -r dir; do
    bash "$VALIDATE_SCRIPT" "$dir" || EXIT_CODE=1
done <<< "$GENERATED_DIRS"

# ── 最终结果 ─────────────────────────────
echo ""
if [[ $EXIT_CODE -eq 0 ]]; then
    echo "🎉 fault-pattern-network 测试通过！"
    echo "   生成位置: $OUTPUT_DIR"
else
    echo "💥 fault-pattern-network 测试失败，请检查上方的验证报告。"
fi
echo ""
exit $EXIT_CODE
