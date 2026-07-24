#!/bin/bash
set +e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/../lib/common.sh"
source "$SCRIPT_DIR/subagent-detect.sh"

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | json_extract_string ".session_id")
LAST_MSG=$(echo "$INPUT" | json_extract_string ".last_assistant_message")
LOOP_COUNT=$(echo "$INPUT" | json_extract_string ".loop_count")
[ -z "$SESSION_ID" ] && exit 0

# Truncate and redact
SAFE_MSG=$(truncate_str "$LAST_MSG" 20000)
SAFE_MSG=$(redact_text "$SAFE_MSG")
ESCAPED_MSG=$(json_escape "$SAFE_MSG")

# Record agent response
write_spool \
  "agent.response" \
  "$SESSION_ID" \
  "$SESSION_ID" \
  "" \
  "{\"finalResult\": \"$ESCAPED_MSG\", \"length\": ${#SAFE_MSG}, \"loopCount\": ${LOOP_COUNT:-0}}"
# Write subagent.end if this session is a sub-agent
PARENT_ID=$(get_parent_id "$SESSION_ID")
if [ -n "$PARENT_ID" ]; then
  write_spool "agent.subagent.end" "$SESSION_ID" "$SESSION_ID" "$PARENT_ID" "{\"parent_session_id\": \"$PARENT_ID\"}"
fi

# Unregister from subagent tracking
unregister_session "$SESSION_ID"
exit 0
