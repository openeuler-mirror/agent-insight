#!/bin/bash
# ============================================================================
# Agent Insight TRAE Collector — Common Library
# Shared functions for all Hook event handler scripts.
# Source this file: source "$(dirname "$0")/../lib/common.sh"
# ============================================================================

# --- Load TRAE-specific config from .env as fallback ---
_load_trae_env() {
  local env_file="${HOME}/.agent-insight/.env"
  [ -f "$env_file" ] || return 0
  while IFS='=' read -r key value || [ -n "$key" ]; do
    key="$(echo "$key" | tr -d ' ')"
    value="$(echo "$value" | tr -d "'\"")"
    case "$key" in
      AGENT_INSIGHT_TRAE_MAX_CONTENT_LENGTH) [ -z "${AGENT_INSIGHT_TRAE_MAX_CONTENT_LENGTH:-}" ] && export AGENT_INSIGHT_TRAE_MAX_CONTENT_LENGTH="$value" ;;
      AGENT_INSIGHT_TRAE_MAX_TOOL_IO_SIZE)   [ -z "${AGENT_INSIGHT_TRAE_MAX_TOOL_IO_SIZE:-}" ] && export AGENT_INSIGHT_TRAE_MAX_TOOL_IO_SIZE="$value" ;;
      AGENT_INSIGHT_TRAE_SPOOL_RETENTION_DAYS) [ -z "${AGENT_INSIGHT_TRAE_SPOOL_RETENTION_DAYS:-}" ] && export AGENT_INSIGHT_TRAE_SPOOL_RETENTION_DAYS="$value" ;;
    esac
  done < <(grep -E '^AGENT_INSIGHT_TRAE_' "$env_file" 2>/dev/null || true)
}
_load_trae_env
# ============================================================================
# --- Spool Directory ---
get_spool_base() {
  local insight_dir="${AGENT_INSIGHT_DIR:-$HOME/.agent-insight}"
  local api_key="${AGENT_INSIGHT_API_KEY:-}"; [ -z "$api_key" ] && [ -f "$HOME/.agent-insight/.env" ] && api_key=$(grep AGENT_INSIGHT_API_KEY "$HOME/.agent-insight/.env" | head -1 | cut -d= -f2 | tr -d "'")
  local key_hash=""
  if [ -n "$api_key" ]; then
    key_hash=$(echo -n "$api_key" | sha256sum 2>/dev/null | cut -c1-16 || echo "")
  fi
  if [ -n "$key_hash" ]; then
    echo "$insight_dir/otel_data/trae/$key_hash"
  else
    echo "$insight_dir/otel_data/trae/default"
  fi
}

get_spool_dir() {
  local base; base=$(get_spool_base)
  local day_dir="$base/$(date -u +%Y-%m-%d)"
  mkdir -p "$day_dir" 2>/dev/null
  echo "$day_dir"
}

get_spool_file() {
  local dir; dir=$(get_spool_dir)
  echo "$dir/trae-otel-$(hostname 2>/dev/null || echo 'unknown').jsonl"
}

# --- JSON Helpers ---
json_extract_string() {
  local expr="$1"
  python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    val = data
    for part in '${expr}'.lstrip('.').split('.'):
        if isinstance(val, dict):
            val = val.get(part, '')
        else:
            val = ''
            break
    if val is None: val = ''
    if not isinstance(val, str): val = json.dumps(val, ensure_ascii=False)
    sys.stdout.write(val)
except:
    sys.stdout.write('')
" 2>/dev/null || printf ''
}

json_extract_object() {
  local expr="$1"
  python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    val = data
    for part in '${expr}'.lstrip('.').split('.'):
        if isinstance(val, dict):
            val = val.get(part, {})
        else:
            val = {}
            break
    if val is None: val = {}
    sys.stdout.write(json.dumps(val, ensure_ascii=False))
except:
    sys.stdout.write('{}')
" 2>/dev/null || printf '{}'
}

# --- Redaction ---
_COMMON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$_COMMON_DIR/redact.sh"

# --- Content Truncation (configurable via env vars) ---
# AGENT_INSIGHT_TRAE_MAX_CONTENT_LENGTH env var overrides default 2000 (对应 AC17)
# AGENT_INSIGHT_TRAE_MAX_TOOL_IO_SIZE env var overrides default 4000 (对应 AC11)
_MAX_CONTENT_LENGTH="${AGENT_INSIGHT_TRAE_MAX_CONTENT_LENGTH:-2000}"
_MAX_TOOL_IO_SIZE="${AGENT_INSIGHT_TRAE_MAX_TOOL_IO_SIZE:-4000}"

truncate_str() {
  local str="$1"
  local max_len="${2:-$_MAX_CONTENT_LENGTH}"
  if [ ${#str} -le "$max_len" ]; then
    printf '%s' "$str"
  else
    printf '%s' "${str:0:$max_len}..."
  fi
}

truncate_payload() {
  local json_str="$1"
  local max_len="${2:-$_MAX_TOOL_IO_SIZE}"
  printf '%s' "$json_str" | python3 -c "
import sys, json
MAX_STR = $max_len
try:
    val = json.load(sys.stdin)
    def trunc(v):
        if isinstance(v, str) and len(v) > MAX_STR:
            return v[:MAX_STR] + '...'
        if isinstance(v, dict):
            return {k: trunc(v) for k, v in v.items()}
        if isinstance(v, list):
            return [trunc(x) for x in v]
        return v
    sys.stdout.write(json.dumps(trunc(val), ensure_ascii=False))
except:
    sys.stdout.write('${json_str}'[:$max_len])
" 2>/dev/null || printf '%s' "$json_str"
}

# --- Spool Writer ---
write_spool() {
  local kind="$1"
  local session_id="$2"
  local trace_id="$3"
  local parent_id="$4"
  local payload="$5"
  local ts; ts=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  local spool_file; spool_file=$(get_spool_file)

  kind="$kind" session_id="$session_id" trace_id="$trace_id" parent_id="$parent_id" payload="$payload" ts="$ts" python3 -c '
import os, json
entry = {"t": os.environ["ts"], "kind": os.environ["kind"], "sessionID": os.environ["session_id"]}
trace = os.environ.get("trace_id", "")
parent = os.environ.get("parent_id", "")
if trace: entry["trace_id"] = trace
if parent: entry["parent_id"] = parent
try: entry["payload"] = json.loads(os.environ["payload"])
except: entry["payload"] = {}
spool = os.environ.get("spool_file", "")
if spool:
    with open(spool, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")
else:
    print(json.dumps(entry, ensure_ascii=False))
' >> "$spool_file" 2>/dev/null
}

# --- Safe JSON escaping for shell ---
json_escape() {
  printf '%s' "$1" | python3 -c "
import sys, json
line = sys.stdin.read()
sys.stdout.write(json.dumps(line, ensure_ascii=False)[1:-1])
" 2>/dev/null || printf '%s' "$1"
}

# --- Spool Cleanup ---
# Remove spool files older than N days
# AGENT_INSIGHT_TRAE_SPOOL_RETENTION_DAYS env var overrides default 7
_SPOOL_RETENTION_DAYS="${AGENT_INSIGHT_TRAE_SPOOL_RETENTION_DAYS:-7}"

cleanup_spool() {
  local retention_days="${1:-$_SPOOL_RETENTION_DAYS}"
  local base; base=$(get_spool_base)
  if [ ! -d "$base" ]; then return; fi
  local cutoff=$(date -u -d "$retention_days days ago" +%Y-%m-%d 2>/dev/null || echo "")
  [ -z "$cutoff" ] && return
  for dir in "$base"/*/; do
    [ -d "$dir" ] || continue
    local dname=$(basename "$dir")
    if [[ "$dname" < "$cutoff" ]]; then
      rm -rf "$dir" 2>/dev/null || true
    fi
  done
}

# Run cleanup on source (won't be called directly from Hook, but available)
cleanup_spool $_SPOOL_RETENTION_DAYS
