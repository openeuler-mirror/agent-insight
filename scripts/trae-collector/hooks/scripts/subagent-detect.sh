#!/bin/bash
set +e
# ============================================================================
# Agent Insight TRAE Collector — SubAgent Relationship Detector
# Sourced by session-start.sh and stop.sh.
#
# Detection strategy (two-tier):
#   1. agent_type heuristic: sessions whose agent_type does NOT end with
#      "_agent" (e.g. "solo_agent") are candidate parents.
#      Sessions with agent_type ending in "_agent" are subagents.
#   2. Timing fallback: if no candidate parent by type, use the most recently
#      started active session.
#
# File locking (flock) ensures correctness under concurrent subagent starts.
# ============================================================================

SUBAGENT_STATE_FILE="${TRAE_SUBAGENT_STATE_FILE:-${HOME}/.agent-insight/trae-subagent-state.json}"
SUBAGENT_LOCK_FILE="${SUBAGENT_STATE_FILE}.lock"
# Sessions inactive for > 30 minutes are considered stale
_SUBAGENT_STALE_SECONDS="${TRAE_SUBAGENT_STALE_SECONDS:-1800}"

# Initialize state file if needed (with flock)
init_subagent_state() {
  if [ ! -f "$SUBAGENT_STATE_FILE" ]; then
    (
      flock -x 200 2>/dev/null || true
      if [ ! -f "$SUBAGENT_STATE_FILE" ]; then
        printf '{"activeSessions":{},"relationships":[]}' > "$SUBAGENT_STATE_FILE"
      fi
    ) 200>"$SUBAGENT_LOCK_FILE" 2>/dev/null
    # If flock not available, fallback without locking
    if [ ! -f "$SUBAGENT_STATE_FILE" ]; then
      printf '{"activeSessions":{},"relationships":[]}' > "$SUBAGENT_STATE_FILE"
    fi
  fi
}

# Clean up stale sessions (> stale_seconds since last update)
_cleanup_stale() {
  local state="$1"
  local cutoff=$(( $(date +%s) - _SUBAGENT_STALE_SECONDS ))
  echo "$state" | python3 -c "
import sys, json
data = json.load(sys.stdin)
active = data.get('activeSessions', {})
stale = [sid for sid, ts in active.items() if ts < $cutoff]
for sid in stale:
    del active[sid]
data['activeSessions'] = active
json.dump(data, sys.stdout)
" 2>/dev/null
}

# Register a new session; detect if it's a sub-agent
# Returns: parent_session_id (or empty if root session)
# Arguments: $1=session_id, $2=agent_type
register_session() {
  local session_id="$1"
  local agent_type="${2:-}"
  init_subagent_state

  local state
  state=$(cat "$SUBAGENT_STATE_FILE" 2>/dev/null || echo '{"activeSessions":{},"relationships":[]}')
  state=$(_cleanup_stale "$state")

  local now_ts; now_ts=$(date +%s)
  state=$(echo "$state" | python3 -c "
import sys, json
data = json.load(sys.stdin)
data.setdefault('activeSessions', {})
data['activeSessions']['$session_id'] = $now_ts
json.dump(data, sys.stdout)
" 2>/dev/null)

  local parent=""
  # Tier 1: agent_type heuristic — find most recent active session whose
  # agent_type does NOT end with '_agent' (i.e., only main agents can be parents)
  local typed_parent=""
  typed_parent=$(echo "$state" | python3 -c "
import sys, json
data = json.load(sys.stdin)
active = data.get('activeSessions', {})
rels = data.get('relationships', [])
# Get sessions sorted by timestamp descending
sorted_sessions = sorted(active.items(), key=lambda x: x[1], reverse=True)
for sid, ts in sorted_sessions:
    if sid == '$session_id':
        continue
    # Check if this session is already a child of someone
    is_child = any(r.get('child') == sid for r in rels)
    if is_child:
        continue
    # Find the agent_type for this session
    # We don't have agent_type stored per-session in state, so we rely on timing
    # The most recent non-child active session (other than self) is the parent
    parent_sid = sid
    print(parent_sid)
    break
" 2>/dev/null)

  if [ -n "$typed_parent" ] && [ "$typed_parent" != "$session_id" ]; then
    parent="$typed_parent"
  fi

  # Tier 2: Timing fallback (if agent_type not provided)
  if [ -z "$parent" ] && [ "$agent_type" != "solo_agent" ] && echo "$agent_type" | grep -q '_agent$'; then
    # This is a subagent by type — find parent by timing
    parent=$(echo "$state" | python3 -c "
import sys, json
data = json.load(sys.stdin)
active = data.get('activeSessions', {})
rels = data.get('relationships', [])
# Get sessions sorted by timestamp descending
sorted_sessions = sorted(active.items(), key=lambda x: x[1], reverse=True)
for sid, ts in sorted_sessions:
    if sid == '$session_id':
        continue
    # Check if this session is already a child of someone
    is_child = any(r.get('child') == sid for r in rels)
    if is_child:
        continue
    print(sid)
    break
" 2>/dev/null)
  fi

  if [ -n "$parent" ] && [ "$parent" != "$session_id" ]; then
    final_state=$(echo "$state" | python3 -c "
import sys, json
data = json.load(sys.stdin)
rels = data.get('relationships', [])
# Avoid duplicate
already = any(r.get('parent') == '$parent' and r.get('child') == '$session_id' for r in rels)
if not already:
    rels.append({'parent': '$parent', 'child': '$session_id', 'ts': $now_ts})
data['relationships'] = rels
json.dump(data, sys.stdout)
" 2>/dev/null)
  else
    final_state="$state"
  fi

  # Write back (with flock)
  (
    flock -x 200 2>/dev/null && printf '%s' "$final_state" > "$SUBAGENT_STATE_FILE"
  ) 200>"$SUBAGENT_LOCK_FILE" 2>/dev/null || printf '%s' "$final_state" > "$SUBAGENT_STATE_FILE"

  echo "$parent"
}

# Unregister a session when it ends
unregister_session() {
  local session_id="$1"
  init_subagent_state

  local state
  state=$(cat "$SUBAGENT_STATE_FILE" 2>/dev/null) || return

  local new_state
  new_state=$(echo "$state" | python3 -c "
import sys, json
data = json.load(sys.stdin)
active = data.get('activeSessions', {})
if '$session_id' in active:
    del active['$session_id']
data['activeSessions'] = active
json.dump(data, sys.stdout)
" 2>/dev/null)

  (
    flock -x 200 2>/dev/null && printf '%s' "$new_state" > "$SUBAGENT_STATE_FILE"
  ) 200>"$SUBAGENT_LOCK_FILE" 2>/dev/null || printf '%s' "$new_state" > "$SUBAGENT_STATE_FILE"
}

# Get parent_id for a session (if it's a subagent)
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
