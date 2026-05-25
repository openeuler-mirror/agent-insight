#!/usr/bin/env bash
# run.sh — general-description-git 测试运行脚本
#
# 场景：通用场景路由（Agent 驱动，无文档输入）
# 输入：用户给出主题需求（"做个 Git Commit 规范的 skill"）
# 期望：skill-generator 路由到通用场景，生成符合规范的 Skill 目录
#
# 用法:
#   ./run.sh                    # 完整流程（setup + opencode + validate）
#   ./run.sh --validate-only /path/to/skill  # 只跑验证
#
# 依赖: opencode 已安装并在 PATH 中

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../../" && pwd)"
VALIDATE_SCRIPT="$PROJECT_ROOT/tests/skill-generator/validate_skill.sh"

OUTPUT_DIR="$PROJECT_ROOT/tests/skill-generator/output/general-description-git"
VALIDATE_ONLY=false
VALIDATE_ONLY_PATH=""

usage() {
    echo "用法: $0 [--output <dir>] [--validate-only <skill_dir>]"
    echo ""
    echo "  --output <dir>           指定生成 Skill 的输出目录（默认: $OUTPUT_DIR）"
    echo "  --validate-only <dir>    跳过 opencode 调用，只对已有目录做验证"
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
echo "║  Skill Generator 测试: general-description-git ║"
echo "║  通用场景路由 → 主题描述生成 Skill   ║"
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

# 安装/更新 skill-generator
echo "  🔄 安装最新版 skill-generator..."
bash "$PROJECT_ROOT/tests/setup_skill_generator.sh"
echo "  ✅ skill-generator 已就绪"

# ── Step 2: 清理并准备输出目录 ───────────
echo ""
echo "【Step 2】准备输出目录: $OUTPUT_DIR"
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

# ── Step 3: 调用 opencode（无头模式）───────
echo ""
echo "【Step 3】调用 opencode 生成 Skill（--auto 模式）"
echo "  （这可能需要 1-3 分钟）"
echo ""

PROMPT="使用 skill-generator，帮我做一个 Git Commit 规范的 Skill，输出到 ${OUTPUT_DIR}。--auto 模式，直接确认大纲并生成，完成后告知输出路径。"

echo "──── Prompt 预览 ────"
echo "$PROMPT"
echo "─────────────────────"
echo ""

"$OPENCODE_CMD" run "$PROMPT"

# ── Step 4: 验证输出 ─────────────────────
echo ""
echo "【Step 4】验证输出"

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
    echo "🎉 general-description-git 测试通过！"
    echo "   生成位置: $OUTPUT_DIR"
else
    echo "💥 general-description-git 测试失败，请检查上方的验证报告。"
fi
echo ""
exit $EXIT_CODE
