#!/bin/bash
# ============================================================================
# Agent Insight TRAE Collector — PreToolUse Handler
# Triggered before a tool is executed by the agent.
# stdin: { "session_id": "...", "hook_event_name": "PreToolUse",
#          "tool_use_id": "...", "tool_name": "...", "llm_tool_name": "...",
#          "tool_input": { ... } }
# stdout: JSON with permissionDecision to control tool execution
# ============================================================================
set +e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/../lib/common.sh"

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | json_extract_string ".session_id")
TOOL_USE_ID=$(echo "$INPUT" | json_extract_string ".tool_use_id")
TOOL_NAME=$(echo "$INPUT" | json_extract_string ".tool_name")
LLM_TOOL_NAME=$(echo "$INPUT" | json_extract_string ".llm_tool_name")
TOOL_INPUT=$(echo "$INPUT" | json_extract_object ".tool_input")

if [ -z "$SESSION_ID" ] || [ -z "$TOOL_USE_ID" ]; then
  exit 0
fi

# Generate trace_id for this tool call
TOOL_TRACE_ID="tool_${TOOL_USE_ID}"

# Redact and truncate the tool input
SAFE_INPUT=$(redact_json "$TOOL_INPUT")
SAFE_INPUT=$(truncate_payload "$SAFE_INPUT")

# Determine tool type
TOOL_TYPE="unknown"
case "$TOOL_NAME" in
  "Read")       TOOL_TYPE="file_read" ;;
  "Write")      TOOL_TYPE="file_write" ;;
  "Edit")       TOOL_TYPE="file_edit" ;;
  "Glob"|"Grep"|"LS") TOOL_TYPE="search" ;;
  "RunCommand") TOOL_TYPE="terminal" ;;
  "WebSearch"|"WebFetch") TOOL_TYPE="web" ;;
  "AskUserQuestion") TOOL_TYPE="interaction" ;;
  "Skill")      TOOL_TYPE="skill" ;;
  mcp__*)       TOOL_TYPE="mcp" ;;
esac

# Detect MCP server name and tool name from mcp__ format
MCP_SERVER_NAME=""
MCP_TOOL_NAME=""
if [[ "$TOOL_NAME" == mcp__* ]]; then
  # Format: mcp__<serverName>__<toolName>
  # Extract by removing mcp__ prefix and splitting on __
  rest="${TOOL_NAME#mcp__}"
  # rest is now "<serverName>__<toolName>"
  MCP_SERVER_NAME="${rest%%__*}"
  MCP_TOOL_NAME="${rest#*__}"
fi

# Record tool call start to spool
PAYLOAD="{\"toolName\": \"$(json_escape "$TOOL_NAME")\", \"toolType\": \"$TOOL_TYPE\", \"llm_tool_name\": \"$(json_escape "$LLM_TOOL_NAME")\""
if [ -n "$MCP_SERVER_NAME" ]; then
  PAYLOAD="$PAYLOAD, \"mcpServerName\": \"$(json_escape "$MCP_SERVER_NAME")\", \"mcpToolName\": \"$(json_escape "$MCP_TOOL_NAME")\""
fi
PAYLOAD="$PAYLOAD, \"toolInput\": $SAFE_INPUT}"
PAYLOAD=$(truncate_payload "$PAYLOAD")

write_spool \
  "tool.call.start" \
  "$SESSION_ID" \
  "$TOOL_TRACE_ID" \
  "$SESSION_ID" \
  "$PAYLOAD"

# Allow tool execution (don't block)
echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'
exit 0
