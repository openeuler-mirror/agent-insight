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
SESSION_ID=$(echo "$INPUT" | json_extract_string ".session_id")
PROMPT=$(echo "$INPUT" | json_extract_string ".prompt")

if [ -z "$SESSION_ID" ]; then
  exit 0
fi

# Truncate and redact prompt
SAFE_PROMPT=$(truncate_str "$PROMPT" 2000)
SAFE_PROMPT=$(redact_text "$SAFE_PROMPT")

# Escape for JSON payload
ESCAPED_PROMPT=$(json_escape "$SAFE_PROMPT")

# Record user prompt to spool
write_spool \
  "agent.prompt" \
  "$SESSION_ID" \
  "$SESSION_ID" \
  "" \
  "{\"query\": \"$ESCAPED_PROMPT\", \"length\": ${#SAFE_PROMPT}}"

exit 0
