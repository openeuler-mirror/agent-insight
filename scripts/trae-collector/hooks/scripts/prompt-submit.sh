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

# 写入 TRAE_ENV_FILE，供 stop.sh 读取精确 prompt token
if [ -n "${TRAE_ENV_FILE:-}" ]; then
  PROMPT_LEN=${#PROMPT}
  echo "AGENT_INSIGHT_PROMPT_LENGTH=$PROMPT_LEN" >> "$TRAE_ENV_FILE" 2>/dev/null
  echo "AGENT_INSIGHT_SESSION_ID=$SESSION_ID" >> "$TRAE_ENV_FILE" 2>/dev/null
fi

exit 0
