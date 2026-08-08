#!/bin/bash
# ============================================================================
# Agent Insight TRAE Collector — PreToolUse Handler
# Triggered before a tool is executed by the agent.
# stdin: { "session_id": "...", "hook_event_name": "PreToolUse",
#          "tool_use_id": "...", "tool_name": "...", "llm_tool_name": "...",
#          "tool_input": { ... }, "agent_id": "...", "agent_type": "..." }
# stdout: JSON with permissionDecision to control tool execution
#
# AC10-13: Captures tool call start with tool type classification.
#   TRAE fires PreToolUse/PostToolUse for ALL tools (built-in, Skill, MCP).
#   We classify here so both pre/post share consistent types.
# ============================================================================
set +e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/../lib/common.sh"

INPUT=$(cat)
debug_raw_input "$INPUT" "PreToolUse"
SESSION_ID=$(echo "$INPUT" | json_extract_string ".session_id")
TOOL_USE_ID=$(echo "$INPUT" | json_extract_string ".tool_use_id")
TOOL_NAME=$(echo "$INPUT" | json_extract_string ".tool_name")
LLM_TOOL_NAME=$(echo "$INPUT" | json_extract_string ".llm_tool_name")
TOOL_INPUT=$(echo "$INPUT" | json_extract_object ".tool_input")
# Parse tool_input if it's a string containing JSON
TOOL_INPUT=$(echo "$TOOL_INPUT" | python3 -c "
import sys, json
try:
    val = json.load(sys.stdin)
    if isinstance(val, str):
        val = json.loads(val)
    print(json.dumps(val, ensure_ascii=False))
except:
    print('{}')
")
AGENT_ID=$(echo "$INPUT" | json_extract_string ".agent_id")
AGENT_TYPE=$(echo "$INPUT" | json_extract_string ".agent_type")
CWD=$(echo "$INPUT" | json_extract_string ".cwd")

if [ -z "$SESSION_ID" ] || [ -z "$TOOL_USE_ID" ]; then
  exit 0
fi

TOOL_TRACE_ID="tool_${TOOL_USE_ID}"

SAFE_INPUT=$(redact_json "$TOOL_INPUT")
SAFE_INPUT=$(truncate_payload "$SAFE_INPUT")

# ============================================================================
# Unified Tool Type Classification
# TRAE fires PreToolUse/PostToolUse for ALL tools including Skill and MCP.
# We classify here so both pre/post share consistent tool types.
# ============================================================================

# Known TRAE built-in tool names
_is_trae_builtin() {
  case "$1" in
    LS|Read|Write|Edit|Glob|Grep|\
    Bash|RunCommand|Exec|\
    WebSearch|WebFetch|\
    AskUserQuestion|Question|\
    Task|TodoWrite|\
    Skill) return 0 ;;
    *) return 1 ;;
  esac
}

# MCP tool detection (two-tier):
#   Priority 1: official mcp__<server>__<tool> prefix
#   Priority 2: snake_case llm_tool_name heuristic (fallback)
_is_mcp_tool() {
  local tname="$1"
  local lname="${2:-$1}"
  # 官方 mcp__ 前缀（100% 可靠）
  if echo "$tname" | grep -q '^mcp__'; then
    return 0
  fi
  # 兜底：llm_tool_name 含下划线且与 tool_name 不同
  if [ "$tname" != "$lname" ] && echo "$lname" | grep -q '_'; then
    return 0
  fi
  # 兜底：常见 MCP 工具名模式
  case "$tname" in
    Browser*|browser_*) return 0 ;;
    *) return 1 ;;
  esac
}

TOOL_TYPE="unknown"

if _is_trae_builtin "$TOOL_NAME"; then
  case "$TOOL_NAME" in
    Read)                            TOOL_TYPE="file_read" ;;
    Write)                           TOOL_TYPE="file_write" ;;
    Edit)                            TOOL_TYPE="file_edit" ;;
    Glob|Grep|LS)                    TOOL_TYPE="search" ;;
    Bash|RunCommand|Exec)            TOOL_TYPE="terminal" ;;
    WebSearch|WebFetch)              TOOL_TYPE="web" ;;
    AskUserQuestion|Question)        TOOL_TYPE="interaction" ;;
    Task|TodoWrite)                  TOOL_TYPE="task" ;;
    Skill)                           TOOL_TYPE="skill" ;;
    *)                               TOOL_TYPE="unknown" ;;
  esac
elif _is_mcp_tool "$TOOL_NAME" "$LLM_TOOL_NAME"; then
  TOOL_TYPE="mcp"
elif [ "$LLM_TOOL_NAME" != "$TOOL_NAME" ] && echo "$LLM_TOOL_NAME" | grep -qE '^[a-z]'; then
  # Fallback: llm_tool_name is lowercase while tool_name is PascalCase → MCP
  TOOL_TYPE="mcp"
else
  TOOL_TYPE="tool"
fi

# Extract skill name from Skill tool input
SKILL_NAME=""
SKILL_VERSION=""
if [ "$TOOL_TYPE" = "skill" ]; then
  SKILL_NAME=$(echo "$INPUT" | json_extract_string ".tool_input.name")
  [ -z "$SKILL_NAME" ] && SKILL_NAME=$(echo "$INPUT" | json_extract_string ".tool_input.skill")
  [ -z "$SKILL_NAME" ] && SKILL_NAME="$TOOL_NAME"
fi

# Redact inline sensitive patterns in command strings for terminal tools
# (complements redact_json which only handles key-value pairs)
if [ "$TOOL_TYPE" = "terminal" ]; then
  SAFE_INPUT=$(echo "$SAFE_INPUT" | python3 "$SCRIPT_DIR/../lib/redact_command.py" 2>/dev/null || echo "$SAFE_INPUT")
fi

# Build tool call start payload
PAYLOAD="{\"toolName\": \"$(json_escape "$TOOL_NAME")\", \"toolType\": \"$TOOL_TYPE\", \"llm_tool_name\": \"$(json_escape "$LLM_TOOL_NAME")\", \"toolUseId\": \"$(json_escape "$TOOL_USE_ID")\""

if [ "$TOOL_TYPE" = "skill" ] && [ -n "$SKILL_NAME" ]; then
  PAYLOAD="$PAYLOAD, \"skillName\": \"$(json_escape "$SKILL_NAME")\""
  [ -n "$SKILL_VERSION" ] && PAYLOAD="$PAYLOAD, \"skillVersion\": \"$(json_escape "$SKILL_VERSION")\""
  PAYLOAD="$PAYLOAD, \"triggerMode\": \"auto\""
fi

if [ -n "$CWD" ]; then
  PAYLOAD="$PAYLOAD, \"cwd\": \"$(json_escape "$CWD")\""
fi

# MCP-specific: extract serverName/toolName from mcp__ prefix (official) or fallback to llm_tool_name
if [ "$TOOL_TYPE" = "mcp" ]; then
  MCP_SERVER_NAME=""
  MCP_TOOL_NAME=""
  if echo "$TOOL_NAME" | grep -q '^mcp__'; then
    _parse_mcp_name "$TOOL_NAME"
  else
    MCP_SERVER_NAME="trae"
    MCP_TOOL_NAME="$LLM_TOOL_NAME"
  fi
  PAYLOAD="$PAYLOAD, \"mcpServerName\": \"$(json_escape "$MCP_SERVER_NAME")\", \"mcpToolName\": \"$(json_escape "$MCP_TOOL_NAME")\""
fi

# Subagent inline detection: mark tools executed by sub-agents within same session
if [ "$AGENT_TYPE" != "solo_agent" ] && echo "$AGENT_TYPE" | grep -q '_agent$'; then
  PAYLOAD="$PAYLOAD, \"subagentId\": \"$(json_escape "$AGENT_ID")\", \"subagentType\": \"$(json_escape "$AGENT_TYPE")\""
fi

PAYLOAD="$PAYLOAD, \"toolInput\": $SAFE_INPUT}"
PAYLOAD=$(truncate_payload "$PAYLOAD")

write_spool \
  "tool.call.start" \
  "$SESSION_ID" \
  "$TOOL_TRACE_ID" \
  "$SESSION_ID" \
  "$PAYLOAD" \
  "$AGENT_ID" \
  "$AGENT_TYPE"

# Output tool type classification to shared state so post-tool-use can read it
# (avoids re-classification drift between pre and post)
_TOOL_STATE_DIR="${TRAE_TOOL_STATE_DIR:-/tmp/.trae-tool-state}"
mkdir -p "$_TOOL_STATE_DIR" 2>/dev/null
printf '{"toolType":"%s","toolName":"%s","skillName":"%s"}' "$TOOL_TYPE" "$TOOL_NAME" "$SKILL_NAME" > "$_TOOL_STATE_DIR/${TOOL_USE_ID}.json" 2>/dev/null

# Allow tool execution (don't block)
echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'
exit 0
