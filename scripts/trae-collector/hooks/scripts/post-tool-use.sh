#!/bin/bash
# ============================================================================
# Agent Insight TRAE Collector — PostToolUse Handler
# Triggered after a tool has been executed by the agent.
# stdin: { "session_id": "...", "hook_event_name": "PostToolUse",
#          "tool_use_id": "...", "tool_name": "...", "llm_tool_name": "...",
#          "tool_input": { ... }, "tool_response": { ... } }
# stdout: JSON with decision to control agent flow
# ============================================================================
set +e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/../lib/common.sh"

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | json_extract_string ".session_id")
TOOL_USE_ID=$(echo "$INPUT" | json_extract_string ".tool_use_id")
TOOL_NAME=$(echo "$INPUT" | json_extract_string ".tool_name")
TOOL_INPUT=$(echo "$INPUT" | json_extract_object ".tool_input")
TOOL_RESPONSE=$(echo "$INPUT" | json_extract_object ".tool_response")

if [ -z "$SESSION_ID" ] || [ -z "$TOOL_USE_ID" ]; then
  exit 0
fi

TOOL_TRACE_ID="tool_${TOOL_USE_ID}"

# Redact and truncate
SAFE_RESPONSE=$(redact_json "$TOOL_RESPONSE")
SAFE_RESPONSE=$(truncate_payload "$SAFE_RESPONSE")

# Extract exit code / error info
EXIT_CODE=$(echo "$TOOL_RESPONSE" | json_extract_string ".exit_code")
ERROR_MSG=$(echo "$TOOL_RESPONSE" | json_extract_string ".error")
if [ -z "$ERROR_MSG" ]; then
  ERROR_MSG=$(echo "$TOOL_RESPONSE" | json_extract_string ".stderr")
fi

# Record tool call completion to spool
PAYLOAD="{\"toolName\": \"$(json_escape "$TOOL_NAME")\""
if [ -n "$EXIT_CODE" ]; then
  PAYLOAD="$PAYLOAD, \"exitCode\": $EXIT_CODE"
fi
if [ -n "$ERROR_MSG" ]; then
  SAFE_ERROR=$(truncate_str "$(redact_text "$ERROR_MSG")" 2000)
  PAYLOAD="$PAYLOAD, \"error\": \"$(json_escape "$SAFE_ERROR")\""
fi
PAYLOAD="$PAYLOAD, \"toolResponse\": $SAFE_RESPONSE}"
PAYLOAD=$(truncate_payload "$PAYLOAD")

write_spool \
  "tool.call.end" \
  "$SESSION_ID" \
  "$TOOL_TRACE_ID" \
  "$SESSION_ID" \
  "$PAYLOAD"

exit 0
