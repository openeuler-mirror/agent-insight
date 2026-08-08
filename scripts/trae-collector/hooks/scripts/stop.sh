#!/bin/bash
set +e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/../lib/common.sh"
source "$SCRIPT_DIR/subagent-detect.sh"

INPUT=$(cat)
debug_raw_input "$INPUT" "Stop"
SESSION_ID=$(echo "$INPUT" | json_extract_string ".session_id")
AGENT_ID=$(echo "$INPUT" | json_extract_string ".agent_id")
AGENT_TYPE=$(echo "$INPUT" | json_extract_string ".agent_type")
LAST_MSG=$(echo "$INPUT" | json_extract_string ".last_assistant_message")
TEXT_CONTENT=$(echo "$INPUT" | json_extract_string ".text_content")
LOOP_COUNT=$(echo "$INPUT" | json_extract_string ".loop_count")
STOP_ACTIVE=$(echo "$INPUT" | json_extract_string ".stop_hook_active")
[ -z "$SESSION_ID" ] && exit 0

# Prefer text_content, fall back to last_assistant_message
FULL_MSG="${TEXT_CONTENT:-$LAST_MSG}"

# Truncate and redact (20000 chars max for final result, 2000 for llm trace)
SAFE_MSG=$(truncate_str "$FULL_MSG" 20000)
SAFE_MSG=$(redact_text "$SAFE_MSG")
ESCAPED_MSG=$(json_escape "$SAFE_MSG")

# --- agent.response (always) ---
write_spool \
  "agent.response" \
  "$SESSION_ID" \
  "$SESSION_ID" \
  "" \
  "{\"finalResult\": \"$ESCAPED_MSG\", \"length\": ${#SAFE_MSG}, \"loopCount\": ${LOOP_COUNT:-0}, \"stopActive\": ${STOP_ACTIVE:-false}}" \
  "$AGENT_ID" \
  "$AGENT_TYPE"

# --- agent.session.stop (marks session as complete for upload dedup) ---
write_spool \
  "agent.session.stop" \
  "$SESSION_ID" \
  "$SESSION_ID" \
  "" \
  "{\"reason\": \"stop-hook\", \"loopCount\": ${LOOP_COUNT:-0}, \"resultLength\": ${#SAFE_MSG}}" \
  "$AGENT_ID" \
  "$AGENT_TYPE"

# --- llm.call (language-aware token estimation — tiktoken too slow for hook scripts) ---
LLM_TRUNCATED=$(truncate_str "$FULL_MSG" 2000)
LLM_SAFE=$(redact_text "$LLM_TRUNCATED")
LLM_ESCAPED=$(json_escape "$LLM_SAFE")

COMPLETION_TOKENS=$(echo "$FULL_MSG" | python3 -c "
import sys, re
text = sys.stdin.read()
cjk = len(re.findall(r'[\u3400-\u9fff]', text))
latin = len(re.findall(r'[A-Za-z0-9_]+', text.replace(''.join(re.findall(r'[\u3400-\u9fff]', text)), '')))
other = len(re.sub(r'[A-Za-z0-9_\s\u3400-\u9fff]', '', text))
print(max(1, int(cjk * 1.2 + latin * 1.3 + other * 0.5)))
" 2>/dev/null || echo $(( ${#FULL_MSG} / 3 )))

# Prompt tokens: 优先读 prompt-submit.sh 写的语言感知估算状态文件（与 completion 同公式），
# 状态文件缺失/损坏时兜底 completion/2（旧 TRAE_ENV_FILE 方案无设置方，已废弃）
PROMPT_TOKENS=0
SAFE_SESSION_ID=$(echo "$SESSION_ID" | tr -cd '[:alnum:]_-')
PROMPT_STATE_FILE="${AGENT_INSIGHT_DIR:-$HOME/.agent-insight}/trae-prompt-state-${SAFE_SESSION_ID}.json"
if [ -n "$SAFE_SESSION_ID" ] && [ -f "$PROMPT_STATE_FILE" ]; then
  PROMPT_TOKENS=$(python3 -c "import json;print(json.load(open('$PROMPT_STATE_FILE')).get('prompt_tokens',0))" 2>/dev/null || echo "0")
  rm -f "$PROMPT_STATE_FILE" 2>/dev/null
fi
# 兜底：用 completion token 比例反推
if [ "$PROMPT_TOKENS" -eq 0 ] 2>/dev/null; then
  PROMPT_TOKENS=$(( COMPLETION_TOKENS / 2 ))
  PROMPT_TOKENS=$(( PROMPT_TOKENS > 0 ? PROMPT_TOKENS : 1 ))
fi

TOTAL_TOKENS=$(( PROMPT_TOKENS + COMPLETION_TOKENS ))

write_spool \
  "llm.call" \
  "$SESSION_ID" \
  "llm_${SESSION_ID}" \
  "" \
  "{\"promptTokens\": $PROMPT_TOKENS, \"completionTokens\": $COMPLETION_TOKENS, \"tokens\": $TOTAL_TOKENS, \"totalTokens\": $TOTAL_TOKENS, \"latencyMs\": 0, \"estimated\": true, \"estimationMethod\": \"language-aware\", \"responsePreview\": \"$LLM_ESCAPED\"}" \
  "$AGENT_ID" \
  "$AGENT_TYPE"

# --- subagent.end if this session is a sub-agent ---
PARENT_ID=$(get_parent_id "$SESSION_ID")
if [ -n "$PARENT_ID" ]; then
  write_spool "agent.subagent.end" "$SESSION_ID" "$SESSION_ID" "$PARENT_ID" "{\"parent_session_id\": \"$PARENT_ID\"}" "$AGENT_ID" "$AGENT_TYPE"
fi

# Unregister from subagent tracking
unregister_session "$SESSION_ID"
exit 0
