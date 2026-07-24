#!/bin/bash
set +e
# ============================================================================
# Agent Insight TRAE Collector — SubAgent Relationship Detector
# Sourced by session-start.sh.
# Detects when a new session is a sub-agent of an active parent session
# by maintaining a shared state file of active sessions.
# ============================================================================

SUBAGENT_STATE_FILE="${TRAE_SUBAGENT_STATE_FILE:-/tmp/.trae-subagent-state.json}"

# Initialize state file if needed
init_subagent_state() {
  if [ ! -f "$SUBAGENT_STATE_FILE" ]; then
    printf '{"activeSessions":[],"relationships":[]}' > "$SUBAGENT_STATE_FILE"
  fi
}

# Register a new session; detect if it's a sub-agent
# Returns: parent_session_id (or empty if root session)
register_session() {
  local session_id="$1"
  init_subagent_state
  
  local state
  state=$(cat "$SUBAGENT_STATE_FILE")
  
  # Get currently active sessions (sessions that started but haven't ended)
  local active=$(echo "$state" | python3 -c "
import sys, json
data = json.load(sys.stdin)
active = data.get('activeSessions', [])
print(','.join(active) if active else '')
" 2>/dev/null)
  
  local parent=""
  # If there are active sessions, this new session is likely a sub-agent
  if [ -n "$active" ]; then
    # The most recently started active session is the parent
    parent=$(echo "$active" | tr ',' '\n' | tail -1)
  fi
  
  # Update state - add this session to active list
  echo "$state" | python3 -c "
import sys, json
data = json.load(sys.stdin)
sessions = data.get('activeSessions', [])
if '$session_id' not in sessions:
    sessions.append('$session_id')
data['activeSessions'] = sessions
if '$parent' and '$session_id' != '$parent':
    rels = data.get('relationships', [])
    rels.append({'parent': '$parent', 'child': '$session_id'})
    data['relationships'] = rels
json.dump(data, sys.stdout)
" > "$SUBAGENT_STATE_FILE" 2>/dev/null
  
  echo "$parent"
}

# Unregister a session when it ends
unregister_session() {
  local session_id="$1"
  init_subagent_state
  
  local state
  state=$(cat "$SUBAGENT_STATE_FILE" 2>/dev/null) || return
  
  echo "$state" | python3 -c "
import sys, json
data = json.load(sys.stdin)
sessions = data.get('activeSessions', [])
if '$session_id' in sessions:
    sessions.remove('$session_id')
data['activeSessions'] = sessions
json.dump(data, sys.stdout)
" > "$SUBAGENT_STATE_FILE" 2>/dev/null
}

# Get parent_id for a session (if it's a subagent)
# Returns: parent_session_id (or empty if root session)
get_parent_id() {
  local session_id="$1"
  init_subagent_state
  local state
  state=$(cat "$SUBAGENT_STATE_FILE" 2>/dev/null) || return
  echo "$state" | python3 -c "
import sys, json
data = json.load(sys.stdin)
rels = data.get('relationships', [])
for r in rels:
    if r.get('child') == '$session_id':
        print(r.get('parent', ''))
        break
" 2>/dev/null
}
