#!/bin/bash
set +e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/../lib/common.sh"
source "$SCRIPT_DIR/subagent-detect.sh"

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | json_extract_string ".session_id")
[ -z "$SESSION_ID" ] && exit 0

PARENT_ID=$(register_session "$SESSION_ID")

PAYLOAD="{\"source\": \"$(json_extract_string '.source' <<< "$INPUT")\", \"pid\": $$}"
if [ -n "$PARENT_ID" ]; then
  PAYLOAD="$PAYLOAD, \"subagent\": true, \"parent_session_id\": \"$PARENT_ID\""
  write_spool "agent.subagent.start" "$SESSION_ID" "$SESSION_ID" "$PARENT_ID" "$PAYLOAD"
else
  write_spool "agent.session.start" "$SESSION_ID" "$SESSION_ID" "" "$PAYLOAD"
fi

exit 0
