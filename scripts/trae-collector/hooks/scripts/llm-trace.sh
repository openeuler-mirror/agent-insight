#!/bin/bash
set +e
# ============================================================================
# Agent Insight TRAE Collector — LLM Trace Collector (Shell)
# Polls TRAE's internal agent database for LLM call data.
# Designed to be called periodically from the VS Code Extension.
# ============================================================================
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/../lib/common.sh"

DB_PATH="${HOME}/.icube/ai-agent/database.db"
POLL_INTERVAL="${TRAE_LLM_POLL_INTERVAL:-30}"

# Query the TRAE agent database for recent LLM calls
query_llm_calls() {
  if [ ! -f "$DB_PATH" ]; then
    return
  fi
  
  # Try to find the relevant table (might differ between TRAE versions)
  # Common table names: chat_messages, conversation_messages, sessions, llm_calls
  local tables
  tables=$(sqlite3 "$DB_PATH" ".tables" 2>/dev/null) || return
  
  for table in $tables; do
    # Try to get schema
    local schema
    schema=$(sqlite3 "$DB_PATH" "PRAGMA table_info($table);" 2>/dev/null)
    if echo "$schema" | grep -qi "model\|token\|prompt"; then
      # Found a table with LLM-related columns
      local query="SELECT * FROM \"$table\" ORDER BY rowid DESC LIMIT 10"
      local results
      results=$(sqlite3 -json "$DB_PATH" "$query" 2>/dev/null) || continue
      
      # Process results
      echo "$results" | python3 -c "
import sys, json
try:
    records = json.load(sys.stdin)
    if isinstance(records, dict):
        records = [records]
    for rec in records:
        session_id = rec.get('session_id') or rec.get('sessionId') or rec.get('conversation_id') or ''
        model = rec.get('model') or rec.get('model_name') or rec.get('llm_model') or ''
        p_tokens = rec.get('prompt_tokens') or rec.get('input_tokens') or rec.get('promptTokens') or 0
        c_tokens = rec.get('completion_tokens') or rec.get('output_tokens') or rec.get('completionTokens') or 0
        provider = rec.get('provider') or rec.get('llm_provider') or ''
        if session_id:
            print(json.dumps({
                'session_id': session_id,
                'model': model,
                'provider': provider,
                'prompt_tokens': int(p_tokens) if str(p_tokens).isdigit() else 0,
                'completion_tokens': int(c_tokens) if str(c_tokens).isdigit() else 0,
            }))
except:
    pass
" 2>/dev/null | while IFS= read -r line; do
        [ -z "$line" ] && continue
        local session_id
        session_id=$(echo "$line" | python3 -c "import sys,json;print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null)
        [ -z "$session_id" ] && continue
        
        # Write to spool
        write_spool "llm.call" "$session_id" "llm_${session_id}" "" "$line"
      done
    fi
  done
}

# Run once
query_llm_calls
exit 0
