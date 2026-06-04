#!/bin/bash
# ============================================================================
# evaluate_result.sh - 基于 Insight 平台评估执行结果是否达标
#
# 从 /api/skills/logs 接口获取最新一条执行记录的 answer_score，
# 与 score_threshold 对比，判断是否达标。
#
# answer_score 范围可能是 0~1（如 0.625）或 0~100（如 62.5），
# 脚本会自动处理：如果 score <= 1 且 threshold > 1，则将 score * 100 后对比。
#
# 退出码:
#   0 = 达标，停止迭代
#   1 = 未达标，继续优化
#   2 = 错误（配置缺失、接口异常等）
# ============================================================================

set -euo pipefail

ROUND=""
SKILL_NAME=""
SCORE_THRESHOLD=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --round) ROUND="$2"; shift 2 ;;
        --skill-name) SKILL_NAME="$2"; shift 2 ;;
        --score-threshold) SCORE_THRESHOLD="$2"; shift 2 ;;
        *) echo "未知参数: $1"; exit 2 ;;
    esac
done

if [[ -z "$SKILL_NAME" ]]; then
    echo "[evaluate] 错误: 缺少 --skill-name 参数"
    exit 2
fi

if [[ -z "$SCORE_THRESHOLD" ]]; then
    echo "[evaluate] 错误: 缺少 --score-threshold 参数"
    exit 2
fi

# ============================================================================
# 加载 Insight 平台配置
# ============================================================================

if [[ -f "$HOME/.agent-insight/.env" ]]; then
    ENV_FILE="$HOME/.agent-insight/.env"
else
    ENV_FILE="$HOME/.skill-insight/.env"
fi

if [[ ! -f "$ENV_FILE" ]]; then
    echo "[evaluate] 错误: 环境配置文件不存在: $ENV_FILE"
    echo "请创建该文件并配置 AGENT_INSIGHT_HOST 和 AGENT_INSIGHT_API_KEY"
    exit 2
fi

INSIGHT_HOST=""
INSIGHT_API_KEY=""

while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue

    if [[ "$line" =~ ^AGENT_INSIGHT_HOST=(.+)$ ]]; then
        INSIGHT_HOST="${BASH_REMATCH[1]}"
        INSIGHT_HOST="${INSIGHT_HOST%\"}" ; INSIGHT_HOST="${INSIGHT_HOST#\"}"
        INSIGHT_HOST="${INSIGHT_HOST%\'}" ; INSIGHT_HOST="${INSIGHT_HOST#\'}"
    fi

    if [[ "$line" =~ ^AGENT_INSIGHT_API_KEY=(.+)$ ]]; then
        INSIGHT_API_KEY="${BASH_REMATCH[1]}"
        INSIGHT_API_KEY="${INSIGHT_API_KEY%\"}" ; INSIGHT_API_KEY="${INSIGHT_API_KEY#\"}"
        INSIGHT_API_KEY="${INSIGHT_API_KEY%\'}" ; INSIGHT_API_KEY="${INSIGHT_API_KEY#\'}"
    fi
done < "$ENV_FILE"

if [[ -z "$INSIGHT_HOST" ]]; then
    echo "[evaluate] 错误: $ENV_FILE 中未找到 AGENT_INSIGHT_HOST"
    exit 2
fi

if [[ -z "$INSIGHT_API_KEY" ]]; then
    echo "[evaluate] 错误: $ENV_FILE 中未找到 AGENT_INSIGHT_API_KEY"
    exit 2
fi

INSIGHT_HOST="${INSIGHT_HOST%/}"

# ============================================================================
# 轮询获取评分结果
# 使用临时文件传递 JSON，避免 bash 字符串拼接破坏 JSON 内容
# ============================================================================

echo "=========================================="
echo "评估报告 - 第 ${ROUND} 轮"
echo "=========================================="
echo "Skill 名称:   $SKILL_NAME"
echo "达标阈值:     ${SCORE_THRESHOLD}"
echo ""

# apiKey 同时通过 URL 参数和 Header 传递，确保兼容
API_URL="${INSIGHT_HOST}/api/skills/logs?skill=${SKILL_NAME}&limit=1&apiKey=${INSIGHT_API_KEY}"

POLL_INTERVAL=30
MAX_POLLS=20
POLL_COUNT=0
TMPFILE=$(mktemp)
GOT_SCORE="false"

echo "等待 Insight 平台返回评分结果（每 ${POLL_INTERVAL} 秒轮询一次，最多 ${MAX_POLLS} 次）..."

while [[ $POLL_COUNT -lt $MAX_POLLS ]]; do
    POLL_COUNT=$((POLL_COUNT + 1))

    # 将 API 响应 body 直接写入临时文件
    HTTP_CODE=$(curl -s -o "$TMPFILE" -w "%{http_code}" \
        -H "x-witty-api-key: ${INSIGHT_API_KEY}" \
        -H "Content-Type: application/json" \
        "$API_URL" 2>/dev/null) || HTTP_CODE="000"

    if [[ "$HTTP_CODE" != "200" ]]; then
        echo "  [${POLL_COUNT}/${MAX_POLLS}] API 返回 ${HTTP_CODE}，${POLL_INTERVAL}s 后重试..."
        sleep "$POLL_INTERVAL"
        continue
    fi

    # 用 python 从临时文件解析 JSON，判断是否有有效评分
    HAS_SCORE=$(python3 << PYEOF
import json, sys
try:
    with open("$TMPFILE", "r", encoding="utf-8") as f:
        data = json.load(f)
except Exception as e:
    print(f"error:{e}")
    sys.exit(0)
if not isinstance(data, list) or len(data) == 0:
    print("no_data")
elif data[0].get("answer_score") is None:
    print("no_score")
else:
    print("ok")
PYEOF
    )

    if [[ "$HAS_SCORE" == "ok" ]]; then
        echo "  [${POLL_COUNT}/${MAX_POLLS}] 获取到评分结果"
        GOT_SCORE="true"
        break
    elif [[ "$HAS_SCORE" == "no_data" ]]; then
        echo "  [${POLL_COUNT}/${MAX_POLLS}] 暂无执行记录，${POLL_INTERVAL}s 后重试..."
    elif [[ "$HAS_SCORE" == "no_score" ]]; then
        echo "  [${POLL_COUNT}/${MAX_POLLS}] 执行记录存在但评分尚未生成，${POLL_INTERVAL}s 后重试..."
    else
        echo "  [${POLL_COUNT}/${MAX_POLLS}] 解析异常: ${HAS_SCORE}，${POLL_INTERVAL}s 后重试..."
    fi

    sleep "$POLL_INTERVAL"
done

if [[ "$GOT_SCORE" != "true" ]]; then
    echo ""
    echo "警告: 轮询 ${MAX_POLLS} 次（共 $((POLL_INTERVAL * MAX_POLLS)) 秒）后仍未获得评分"
    echo "评估结果: SKIP (超时无数据)"
    echo "=========================================="
    rm -f "$TMPFILE"
    exit 1
fi

echo ""

# ============================================================================
# 解析评分结果（从临时文件中读取）
# ============================================================================

PARSE_RESULT=$(python3 << PYEOF
import json, sys
try:
    with open("$TMPFILE", "r", encoding="utf-8") as f:
        data = json.load(f)
except Exception as e:
    print(f"PARSE_ERROR={e}")
    sys.exit(0)

if not isinstance(data, list) or len(data) == 0:
    print("NO_DATA")
    sys.exit(0)

record = data[0]
score = record.get("answer_score", -1)
query = record.get("query", "")
judgment = record.get("judgment_reason", "")
failures = record.get("failures", [])
skill_issues = record.get("skill_issues", [])
version = record.get("skill_version", "unknown")
label = record.get("label", "")

print(f"SCORE={score}")
print(f"VERSION={version}")
print(f"LABEL={label}")
print(f"QUERY={query[:200]}")
print(f"JUDGMENT={judgment[:500]}")
print(f"FAILURES_COUNT={len(failures)}")
print(f"ISSUES_COUNT={len(skill_issues)}")

if failures:
    for i, f in enumerate(failures[:5]):
        print(f"FAILURE_{i}={str(f)[:200]}")

if skill_issues:
    for i, issue in enumerate(skill_issues[:5]):
        print(f"ISSUE_{i}={str(issue)[:200]}")
PYEOF
)

rm -f "$TMPFILE"

# 提取各字段
SCORE=$(echo "$PARSE_RESULT" | grep "^SCORE=" | head -1 | cut -d= -f2-)
VERSION=$(echo "$PARSE_RESULT" | grep "^VERSION=" | head -1 | cut -d= -f2-)
LABEL=$(echo "$PARSE_RESULT" | grep "^LABEL=" | head -1 | cut -d= -f2-)
QUERY=$(echo "$PARSE_RESULT" | grep "^QUERY=" | head -1 | cut -d= -f2-)
JUDGMENT=$(echo "$PARSE_RESULT" | grep "^JUDGMENT=" | head -1 | cut -d= -f2-)
FAILURES_COUNT=$(echo "$PARSE_RESULT" | grep "^FAILURES_COUNT=" | head -1 | cut -d= -f2-)
ISSUES_COUNT=$(echo "$PARSE_RESULT" | grep "^ISSUES_COUNT=" | head -1 | cut -d= -f2-)

# ============================================================================
# 输出评估详情
# ============================================================================

echo "------------------------------------------"
echo "Insight 平台评估详情"
echo "------------------------------------------"
echo "Skill 版本:    ${LABEL:-v${VERSION}}"
echo "执行得分:      ${SCORE}"
echo "达标阈值:      ${SCORE_THRESHOLD}"
echo "测试 Query:    ${QUERY}"
echo "评判理由:      ${JUDGMENT}"
echo "失败节点数:    ${FAILURES_COUNT}"
echo "Skill 问题数:  ${ISSUES_COUNT}"

if [[ "${FAILURES_COUNT}" -gt 0 ]] 2>/dev/null; then
    echo ""
    echo "失败详情:"
    for i in $(seq 0 $((FAILURES_COUNT - 1))); do
        failure=$(echo "$PARSE_RESULT" | grep "^FAILURE_${i}=" | head -1 | cut -d= -f2-)
        [[ -n "$failure" ]] && echo "  - $failure"
    done
fi

if [[ "${ISSUES_COUNT}" -gt 0 ]] 2>/dev/null; then
    echo ""
    echo "Skill 问题:"
    for i in $(seq 0 $((ISSUES_COUNT - 1))); do
        issue=$(echo "$PARSE_RESULT" | grep "^ISSUE_${i}=" | head -1 | cut -d= -f2-)
        [[ -n "$issue" ]] && echo "  - $issue"
    done
fi

echo ""

# ============================================================================
# 判断是否达标
# answer_score 和 score_threshold 均为 0~1 范围的小数，直接对比
# ============================================================================

if [[ -z "$SCORE" || "$SCORE" == "-1" ]]; then
    echo "评估结果: FAIL (未获取到有效分数)"
    echo "=========================================="
    exit 1
fi

PASS=$(python3 -c "
score = float($SCORE)
threshold = float($SCORE_THRESHOLD)
print('yes' if score >= threshold else 'no')
" 2>/dev/null || echo "no")

if [[ "$PASS" == "yes" ]]; then
    echo "评估结果: PASS (得分 ${SCORE} >= 阈值 ${SCORE_THRESHOLD})"
    echo "=========================================="
    exit 0
else
    echo "评估结果: FAIL (得分 ${SCORE} < 阈值 ${SCORE_THRESHOLD})"
    echo "=========================================="
    exit 1
fi
