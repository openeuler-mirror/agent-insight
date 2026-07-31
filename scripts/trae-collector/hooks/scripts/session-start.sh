#!/bin/bash
set +e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/../lib/common.sh"
source "$SCRIPT_DIR/subagent-detect.sh"

INPUT=$(cat)
debug_raw_input "$INPUT" "SessionStart"
SESSION_ID=$(echo "$INPUT" | json_extract_string ".session_id")
AGENT_ID=$(echo "$INPUT" | json_extract_string ".agent_id")
AGENT_TYPE=$(echo "$INPUT" | json_extract_string ".agent_type")
CWD=$(echo "$INPUT" | json_extract_string ".cwd")
HOOK_EVENT=$(echo "$INPUT" | json_extract_string ".hook_event_name")
WORKSPACE_ROOTS=$(echo "$INPUT" | json_extract_string ".workspace_roots")

[ -z "$SESSION_ID" ] && exit 0

PARENT_ID=$(register_session "$SESSION_ID" "$AGENT_TYPE")

PAYLOAD="{\"source\": \"$(json_extract_string '.source' <<< "$INPUT")\", \"pid\": $$"
if [ -n "$CWD" ]; then
  PAYLOAD="$PAYLOAD, \"cwd\": \"$(json_escape "$CWD")\""
fi
if [ -n "$WORKSPACE_ROOTS" ]; then
  PAYLOAD="$PAYLOAD, \"workspace_roots\": $WORKSPACE_ROOTS"
fi
if [ -n "$PARENT_ID" ]; then
  PAYLOAD="$PAYLOAD, \"subagent\": true, \"parent_session_id\": \"$PARENT_ID\""
  PAYLOAD="$PAYLOAD}"
  write_spool "agent.subagent.start" "$SESSION_ID" "$SESSION_ID" "$PARENT_ID" "$PAYLOAD" "$AGENT_ID" "$AGENT_TYPE"
else
  PAYLOAD="$PAYLOAD}"
  write_spool "agent.session.start" "$SESSION_ID" "$SESSION_ID" "" "$PAYLOAD" "$AGENT_ID" "$AGENT_TYPE"
fi

exit 0
