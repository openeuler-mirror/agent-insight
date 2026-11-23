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

# ============================================================================
# oc_run.sh - opencode run 封装脚本
#
# 封装 opencode run --format json，处理流式 JSON 输出。
# **保证在任何情况下（成功、超时、错误）都会向 stdout 输出内容。**
#
# 用法:
#   # 新会话执行
#   bash oc_run.sh --query "任务" --model "模型名" --log ./execution.log
#
#   # 继续指定会话（通过 sessionID）
#   bash oc_run.sh --session "ses_xxx" --query "回答" --model "模型名" --log ./execution.log
#
#   # 自定义超时（默认 900 秒）
#   bash oc_run.sh --query "任务" --model "模型" --timeout 600
#
# 输出格式:
#   文本内容（来自 type=text 的 JSON）
#   ...
#   [SESSION_ID] ses_xxxx
#
#   最后一行 [SESSION_ID] 标记供调用方提取，用于后续 --session 继续对话。
# ============================================================================

set -euo pipefail

QUERY=""
MODEL=""
LOG_FILE=""
SESSION_ID=""
TIMEOUT=900

while [[ $# -gt 0 ]]; do
    case $1 in
        --query) QUERY="$2"; shift 2 ;;
        --model) MODEL="$2"; shift 2 ;;
        --log) LOG_FILE="$2"; shift 2 ;;
        --session) SESSION_ID="$2"; shift 2 ;;
        --timeout) TIMEOUT="$2"; shift 2 ;;
        *) echo "未知参数: $1"; exit 2 ;;
    esac
done

if [[ -z "$QUERY" ]]; then
    echo "[oc_run] 错误: 缺少 --query 参数"
    exit 2
fi

# 在 query 前面加提示语，不修改原始任务内容
QUERY="（注意：不要调用 question 工具，直接以文字反馈问题与选项）

${QUERY}"

# 构建命令
CMD_ARGS=("opencode" "run" "--format" "json")

# 如果指定了 sessionID，使用 --session 继续对话
if [[ -n "$SESSION_ID" ]]; then
    CMD_ARGS+=("--session" "$SESSION_ID")
fi

CMD_ARGS+=("$QUERY")

if [[ -n "$MODEL" ]]; then
    CMD_ARGS+=("-m" "$MODEL")
fi

# 确保日志目录存在
if [[ -n "$LOG_FILE" ]]; then
    mkdir -p "$(dirname "$LOG_FILE")"
fi

# ============================================================================
# 解析脚本（内联 Python）
# 1. 提取 type=text 的文字内容
# 2. 提取 sessionID（从任意 JSON 中获取）
# 3. 检测 step_finish + reason=stop 结束
# 4. 最后输出 [SESSION_ID] 标记行
# 保证：无论成功、超时、异常，最终都会 print 到 stdout
# ============================================================================

PARSE_SCRIPT=$(cat << 'PYEOF'
import sys
import json
import signal

timeout = int(sys.argv[1]) if len(sys.argv) > 1 else 900
log_file = sys.argv[2] if len(sys.argv) > 2 else ""

text_parts = []
session_id = ""
log_handle = None
finished = False
timed_out = False

def timeout_handler(signum, frame):
    global timed_out
    timed_out = True
    raise SystemExit(0)

signal.signal(signal.SIGALRM, timeout_handler)
signal.alarm(timeout)

try:
    if log_file:
        log_handle = open(log_file, "a", encoding="utf-8")

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            continue

        msg_type = data.get("type", "")

        if log_handle:
            log_handle.write(line + "\n")
            log_handle.flush()

        # 提取 sessionID（取第一个非空的）
        if not session_id:
            sid = data.get("sessionID", "")
            if sid:
                session_id = sid

        # 提取文字内容
        if msg_type == "text":
            part = data.get("part", {})
            text = part.get("text", "")
            if text:
                text_parts.append(text)

        # 检测执行结束
        elif msg_type == "step_finish":
            part = data.get("part", {})
            reason = part.get("reason", "")
            if reason == "stop":
                finished = True
                break

except (SystemExit, KeyboardInterrupt):
    pass
except Exception as e:
    text_parts.append(f"[oc_run] 解析异常: {str(e)}")
finally:
    signal.alarm(0)
    if log_handle:
        log_handle.close()

# === 保证 stdout 一定有输出 ===
if text_parts:
    print("\n".join(text_parts))
    if timed_out:
        print("\n[oc_run] 注意: 执行已超时，以上为超时前收到的内容")
elif timed_out:
    print("[oc_run] 执行超时（已等待 " + str(timeout) + " 秒），未收到任何文本回复")
elif finished:
    print("[oc_run] 执行完成，但未收到文本回复")
else:
    print("[oc_run] 执行结束，未收到有效内容")

# 输出 sessionID 标记行（供调用方提取，用于后续 --session 继续对话）
if session_id:
    print(f"\n[SESSION_ID] {session_id}")
PYEOF
)

# ============================================================================
# 执行
# ============================================================================

"${CMD_ARGS[@]}" 2>/dev/null | python3 -c "$PARSE_SCRIPT" "$TIMEOUT" "$LOG_FILE"
OC_EXIT=${PIPESTATUS[0]}

if [[ $OC_EXIT -ne 0 ]]; then
    echo "[oc_run] opencode 退出码: $OC_EXIT（可能是命令错误或异常中断）"
fi

exit 0
