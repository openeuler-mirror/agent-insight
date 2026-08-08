#!/bin/bash
# ============================================================================
# Agent Insight TRAE Collector — UserPromptSubmit Handler
# Triggered when user submits a query to the agent.
# stdin: { "session_id": "...", "hook_event_name": "UserPromptSubmit", "prompt": "..." }
# stdout: pure text → injected as additional context, or JSON with decision
# ============================================================================
set +e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/../lib/common.sh"

INPUT=$(cat)
debug_raw_input "$INPUT" "UserPromptSubmit"
SESSION_ID=$(echo "$INPUT" | json_extract_string ".session_id")
AGENT_ID=$(echo "$INPUT" | json_extract_string ".agent_id")
AGENT_TYPE=$(echo "$INPUT" | json_extract_string ".agent_type")
PROMPT=$(echo "$INPUT" | json_extract_string ".prompt")
CWD=$(echo "$INPUT" | json_extract_string ".cwd")

if [ -z "$SESSION_ID" ]; then
  exit 0
fi

# Truncate and redact prompt
SAFE_PROMPT=$(truncate_str "$PROMPT" 2000)
SAFE_PROMPT=$(redact_text "$SAFE_PROMPT")

# Escape for JSON payload
ESCAPED_PROMPT=$(json_escape "$SAFE_PROMPT")

# Build payload with additional metadata
PAYLOAD="{\"query\": \"$ESCAPED_PROMPT\", \"length\": ${#SAFE_PROMPT}"
if [ -n "$CWD" ]; then
  PAYLOAD="$PAYLOAD, \"cwd\": \"$(json_escape "$CWD")\""
fi
PAYLOAD="$PAYLOAD}"

# Record user prompt to spool
write_spool \
  "agent.prompt" \
  "$SESSION_ID" \
  "$SESSION_ID" \
  "" \
  "$PAYLOAD" \
  "$AGENT_ID" \
  "$AGENT_TYPE"

# 写入 prompt 语言感知估算状态文件，供 stop.sh 读取（与 completion 同公式）。
# 状态文件替代了未生效的 TRAE_ENV_FILE 环境变量方案：该变量无任何设置方，
# hook 进程环境永无此值，导致此前 prompt 估算实际只有 completion/2 兜底。
SAFE_SESSION_ID=$(echo "$SESSION_ID" | tr -cd '[:alnum:]_-')
if [ -n "$SAFE_SESSION_ID" ]; then
  PROMPT_TOKENS_EST=$(echo "$PROMPT" | python3 -c "
import sys, re
text = sys.stdin.read()
cjk = len(re.findall(r'[\u3400-\u9fff]', text))
latin = len(re.findall(r'[A-Za-z0-9_]+', text.replace(''.join(re.findall(r'[\u3400-\u9fff]', text)), '')))
other = len(re.sub(r'[A-Za-z0-9_\s\u3400-\u9fff]', '', text))
print(max(1, int(cjk * 1.2 + latin * 1.3 + other * 0.5)))
" 2>/dev/null || echo "")
  if [ -n "$PROMPT_TOKENS_EST" ] && [ "$PROMPT_TOKENS_EST" -gt 0 ] 2>/dev/null; then
    PROMPT_STATE_FILE="${AGENT_INSIGHT_DIR:-$HOME/.agent-insight}/trae-prompt-state-${SAFE_SESSION_ID}.json"
    mkdir -p "$(dirname "$PROMPT_STATE_FILE")" 2>/dev/null
    printf '{"session_id":"%s","prompt_tokens":%s,"prompt_length":%s,"ts":%s}\n' \
      "$SAFE_SESSION_ID" "$PROMPT_TOKENS_EST" "${#PROMPT}" "$(date +%s 2>/dev/null || echo 0)" > "$PROMPT_STATE_FILE" 2>/dev/null
  fi
fi

exit 0
