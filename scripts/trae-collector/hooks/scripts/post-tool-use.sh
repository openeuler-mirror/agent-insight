#!/bin/bash
# ============================================================================
# Agent Insight TRAE Collector — PostToolUse Handler
# Triggered after a tool has been executed by the agent.
# stdin: { "session_id": "...", "hook_event_name": "PostToolUse",
#          "tool_use_id": "...", "tool_name": "...", "llm_tool_name": "...",
#          "tool_input": { ... }, "tool_response": { ... },
#          "agent_id": "...", "agent_type": "..." }
# stdout: JSON with decision to control agent flow
#
# AC8/9/18/19: Inline Skill/MCP trace generation.
#   TRAE has no dedicated SkillStart/SkillEnd or McpPreCall/McpPostCall hooks.
#   We detect Skill/MCP calls from tool_name/llm_tool_name and generate
#   dedicated skill.call.* / mcp.call.* events in addition to tool.call.end.
# ============================================================================
set +e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/../lib/common.sh"

INPUT=$(cat)
debug_raw_input "$INPUT" "PostToolUse"
SESSION_ID=$(echo "$INPUT" | json_extract_string ".session_id")
TOOL_USE_ID=$(echo "$INPUT" | json_extract_string ".tool_use_id")
TOOL_NAME=$(echo "$INPUT" | json_extract_string ".tool_name")
TOOL_INPUT=$(echo "$INPUT" | json_extract_object ".tool_input")
TOOL_RESPONSE=$(echo "$INPUT" | json_extract_object ".tool_response")
AGENT_ID=$(echo "$INPUT" | json_extract_string ".agent_id")
AGENT_TYPE=$(echo "$INPUT" | json_extract_string ".agent_type")
LLM_TOOL_NAME=$(echo "$INPUT" | json_extract_string ".llm_tool_name")

if [ -z "$SESSION_ID" ] || [ -z "$TOOL_USE_ID" ]; then
  exit 0
fi

TOOL_TRACE_ID="tool_${TOOL_USE_ID}"

# Read tool type classification from pre-tool-use state file (avoids re-classification drift)
_TOOL_STATE_DIR="${TRAE_TOOL_STATE_DIR:-/tmp/.trae-tool-state}"
_TOOL_STATE_FILE="$_TOOL_STATE_DIR/${TOOL_USE_ID}.json"
TOOL_TYPE="unknown"
SKILL_NAME_FROM_STATE=""
if [ -f "$_TOOL_STATE_FILE" ]; then
  TOOL_TYPE=$(cat "$_TOOL_STATE_FILE" | python3 -c "import sys,json;print(json.load(sys.stdin).get('toolType','unknown'))" 2>/dev/null || echo "unknown")
  SKILL_NAME_FROM_STATE=$(cat "$_TOOL_STATE_FILE" | python3 -c "import sys,json;print(json.load(sys.stdin).get('skillName',''))" 2>/dev/null || echo "")
  rm -f "$_TOOL_STATE_FILE" 2>/dev/null
fi

# ============================================================================
# Authoritative classification by tool_response structure
# Overrides name-based heuristic from pre-tool-use.
# Each tool type has a mutually exclusive response signature:
#   Skill → skill_path + skill_type fields
#   MCP   → content array with mime_type in elements
#   All others → keep pre-tool-use classification
# ============================================================================
_classify_by_response() {
  local response="$1"
  echo "$response" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
except:
    sys.stdout.write('')
    sys.exit(0)
# Skill: skill_path + skill_type are exclusive to Skill calls (100% reliable)
if 'skill_path' in d and 'skill_type' in d:
    sys.stdout.write('skill')
    sys.exit(0)
# MCP: MCP protocol responses always have {content: [...], status: ...}
# content is an array (even if empty) and status field is MCP-exclusive
c = d.get('content')
if isinstance(c, list) and 'status' in d:
    sys.stdout.write('mcp')
    sys.exit(0)
sys.stdout.write('')
" 2>/dev/null || echo ""
}

RESPONSE_TYPE=$(_classify_by_response "$TOOL_RESPONSE")
if [ -n "$RESPONSE_TYPE" ]; then
  TOOL_TYPE="$RESPONSE_TYPE"
fi

# Fallback: re-classify if state file missing
if [ "$TOOL_TYPE" = "unknown" ]; then
  case "$TOOL_NAME" in
    Read) TOOL_TYPE="file_read" ;;
    Write) TOOL_TYPE="file_write" ;;
    Edit) TOOL_TYPE="file_edit" ;;
    Glob|Grep|LS) TOOL_TYPE="search" ;;
    Bash|RunCommand|Exec) TOOL_TYPE="terminal" ;;
    WebSearch|WebFetch) TOOL_TYPE="web" ;;
    AskUserQuestion|Question) TOOL_TYPE="interaction" ;;
    Skill) TOOL_TYPE="skill" ;;
    *) ;;
  esac
  # MCP detection fallback
  if [ "$TOOL_TYPE" = "unknown" ] && [ "$LLM_TOOL_NAME" != "$TOOL_NAME" ] && echo "$LLM_TOOL_NAME" | grep -q '_'; then
    TOOL_TYPE="mcp"
  fi
fi

# Redact and truncate (both input and response for Skill/MCP blocks)
SAFE_INPUT=$(redact_json "$TOOL_INPUT")
SAFE_INPUT=$(truncate_payload "$SAFE_INPUT")
SAFE_RESPONSE=$(redact_json "$TOOL_RESPONSE")
SAFE_RESPONSE=$(truncate_payload "$SAFE_RESPONSE")

# Extract exit code / error info
EXIT_CODE=$(echo "$TOOL_RESPONSE" | json_extract_string ".exit_code")
ERROR_MSG=$(echo "$TOOL_RESPONSE" | json_extract_string ".error")
if [ -z "$ERROR_MSG" ]; then
  ERROR_MSG=$(echo "$TOOL_RESPONSE" | json_extract_string ".stderr")
fi

# ============================================================================
# Record tool.call.end (always)
# ============================================================================
PAYLOAD="{\"toolName\": \"$(json_escape "$TOOL_NAME")\", \"toolType\": \"$TOOL_TYPE\", \"toolUseId\": \"$(json_escape "$TOOL_USE_ID")\""
if [ -n "$LLM_TOOL_NAME" ]; then
  PAYLOAD="$PAYLOAD, \"llm_tool_name\": \"$(json_escape "$LLM_TOOL_NAME")\""
fi
if [ -n "$EXIT_CODE" ]; then
  PAYLOAD="$PAYLOAD, \"exitCode\": $EXIT_CODE"
fi
if [ -n "$ERROR_MSG" ]; then
  SAFE_ERROR=$(truncate_str "$(redact_text "$ERROR_MSG")" 2000)
  PAYLOAD="$PAYLOAD, \"error\": \"$(json_escape "$SAFE_ERROR")\""
fi
# MCP-specific: extract serverName from mcp__ prefix or fallback
if [ "$TOOL_TYPE" = "mcp" ]; then
  if echo "$TOOL_NAME" | grep -q '^mcp__'; then
    _parse_mcp_name "$TOOL_NAME"
  else
    MCP_SERVER_NAME="trae"
    MCP_TOOL_NAME="${LLM_TOOL_NAME:-$TOOL_NAME}"
  fi
  PAYLOAD="$PAYLOAD, \"toolType\": \"mcp\", \"mcpServerName\": \"$(json_escape "$MCP_SERVER_NAME")\", \"mcpToolName\": \"$(json_escape "$MCP_TOOL_NAME")\""
fi
PAYLOAD="$PAYLOAD, \"toolResponse\": $SAFE_RESPONSE}"
PAYLOAD=$(truncate_payload "$PAYLOAD")

write_spool \
  "tool.call.end" \
  "$SESSION_ID" \
  "$TOOL_TRACE_ID" \
  "$SESSION_ID" \
  "$PAYLOAD" \
  "$AGENT_ID" \
  "$AGENT_TYPE"

# ============================================================================
# AC8/AC9: Generate dedicated Skill Trace for Skill tool calls
# ============================================================================
if [ "$TOOL_TYPE" = "skill" ] || [ "$TOOL_NAME" = "Skill" ]; then
  SKILL_NAME="${SKILL_NAME_FROM_STATE:-}"
  [ -z "$SKILL_NAME" ] && SKILL_NAME=$(echo "$INPUT" | json_extract_string ".tool_input.name")
  [ -z "$SKILL_NAME" ] && SKILL_NAME="$TOOL_NAME"

  SKILL_TRACE_ID="skill_${TOOL_USE_ID}"
  SKILL_VERSION=""
  TRIGGER_MODE="auto"

  # Extract skill detail from tool_response (TRAE returns skill metadata)
  SKILL_DETAIL=$(echo "$TOOL_RESPONSE" | json_extract_string ".skill_detail")
  SKILL_PATH=$(echo "$TOOL_RESPONSE" | json_extract_string ".skill_path")
  SKILL_TYPE=$(echo "$TOOL_RESPONSE" | json_extract_string ".skill_type")

  # Try to extract version from skill_detail markdown
  [ -z "$SKILL_VERSION" ] && SKILL_VERSION=$(echo "$SKILL_DETAIL" | grep -oP '版本[:：]\s*\K[\d.]+' 2>/dev/null | head -1 || echo "")
  [ -z "$SKILL_VERSION" ] && SKILL_VERSION=$(echo "$SKILL_DETAIL" | grep -oP '[Vv]ersion[:：\s]+\K[\d.]+' 2>/dev/null | head -1 || echo "")

  SKILL_PAYLOAD="{\"skillName\": \"$(json_escape "$SKILL_NAME")\""
  [ -n "$SKILL_VERSION" ] && SKILL_PAYLOAD="$SKILL_PAYLOAD, \"skillVersion\": \"$(json_escape "$SKILL_VERSION")\""
  [ -n "$TRIGGER_MODE" ] && SKILL_PAYLOAD="$SKILL_PAYLOAD, \"triggerMode\": \"$(json_escape "$TRIGGER_MODE")\""
  [ -n "$SKILL_PATH" ] && SKILL_PAYLOAD="$SKILL_PAYLOAD, \"skillPath\": \"$(json_escape "$SKILL_PATH")\""
  [ -n "$SKILL_TYPE" ] && SKILL_PAYLOAD="$SKILL_PAYLOAD, \"skillType\": \"$(json_escape "$SKILL_TYPE")\""
  # Include redacted input params
  SKILL_PAYLOAD="$SKILL_PAYLOAD, \"params\": $SAFE_INPUT"
  # Include result (from tool_response or skill_detail)
  if [ -n "$SAFE_RESPONSE" ] && [ "$SAFE_RESPONSE" != "{}" ]; then
    SKILL_PAYLOAD="$SKILL_PAYLOAD, \"result\": $SAFE_RESPONSE"
  fi
  if [ -n "$ERROR_MSG" ]; then
    SAFE_ERROR=$(truncate_str "$(redact_text "$ERROR_MSG")" 2000)
    SKILL_PAYLOAD="$SKILL_PAYLOAD, \"error\": \"$(json_escape "$SAFE_ERROR")\""
  fi
  SKILL_PAYLOAD="$SKILL_PAYLOAD}"

  write_spool \
    "skill.call.end" \
    "$SESSION_ID" \
    "$SKILL_TRACE_ID" \
    "$SESSION_ID" \
    "$SKILL_PAYLOAD" \
    "$AGENT_ID" \
    "$AGENT_TYPE"
fi

# ============================================================================
# AC18/AC19: Generate dedicated MCP Trace for MCP tool calls
# ============================================================================
if [ "$TOOL_TYPE" = "mcp" ]; then
  MCP_TRACE_ID="mcp_${TOOL_USE_ID}"
  MCP_SERVER_NAME="trae"
  MCP_TOOL_NAME="${LLM_TOOL_NAME:-$TOOL_NAME}"

  MCP_PAYLOAD="{\"serverName\": \"$(json_escape "$MCP_SERVER_NAME")\", \"toolName\": \"$(json_escape "$MCP_TOOL_NAME")\""
  MCP_PAYLOAD="$MCP_PAYLOAD, \"params\": $SAFE_INPUT"
  if [ -n "$SAFE_RESPONSE" ] && [ "$SAFE_RESPONSE" != "{}" ]; then
    MCP_PAYLOAD="$MCP_PAYLOAD, \"result\": $SAFE_RESPONSE"
  fi
  if [ -n "$ERROR_MSG" ]; then
    SAFE_ERROR=$(truncate_str "$(redact_text "$ERROR_MSG")" 2000)
    MCP_PAYLOAD="$MCP_PAYLOAD, \"error\": \"$(json_escape "$SAFE_ERROR")\""
  fi
  MCP_PAYLOAD="$MCP_PAYLOAD}"

  write_spool \
    "mcp.call.end" \
    "$SESSION_ID" \
    "$MCP_TRACE_ID" \
    "$SESSION_ID" \
    "$MCP_PAYLOAD" \
    "$AGENT_ID" \
    "$AGENT_TYPE"
fi

exit 0
