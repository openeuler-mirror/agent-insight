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
      TRAE_DEBUG_RAW)                        [ -z "${TRAE_DEBUG_RAW:-}" ] && export TRAE_DEBUG_RAW="$value" ;;
    esac
  done < <(grep -E '^AGENT_INSIGHT_TRAE_|^TRAE_DEBUG_RAW=' "$env_file" 2>/dev/null || true)
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
  local agent_id="$6"
  local agent_type="$7"
  local ts; ts=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
  local spool_file; spool_file=$(get_spool_file)

  kind="$kind" session_id="$session_id" trace_id="$trace_id" parent_id="$parent_id" payload="$payload" agent_id="$agent_id" agent_type="$agent_type" ts="$ts" python3 -c '
import os, json
entry = {"t": os.environ["ts"], "kind": os.environ["kind"], "sessionID": os.environ["session_id"]}
trace = os.environ.get("trace_id", "")
parent = os.environ.get("parent_id", "")
agent_id = os.environ.get("agent_id", "")
agent_type = os.environ.get("agent_type", "")
if trace: entry["trace_id"] = trace
if parent: entry["parent_id"] = parent
if agent_id: entry["agent_id"] = agent_id
if agent_type: entry["agent_type"] = agent_type
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

# --- Skill 调用专用函数 ---
# AC8: 记录 Skill 调用事件
write_skill_spool() {
  local kind="$1"
  local session_id="$2"
  local trace_id="$3"
  local parent_id="$4"
  local skill_name="$5"
  local skill_version="$6"
  local trigger_mode="$7"
  local payload="$8"
  local agent_id="$9"
  local agent_type="${10}"
  
  # Build skill-specific payload
  local skill_payload="{\"skillName\": \"$(json_escape "$skill_name")\""
  if [ -n "$skill_version" ]; then
    skill_payload="$skill_payload, \"skillVersion\": \"$(json_escape "$skill_version")\""
  fi
  if [ -n "$trigger_mode" ]; then
    skill_payload="$skill_payload, \"triggerMode\": \"$(json_escape "$trigger_mode")\""
  fi
  if [ -n "$payload" ]; then
    # Merge additional payload
    skill_payload="$skill_payload, $(echo "$payload" | sed 's/^{//;s/}$//')"
  fi
  skill_payload="$skill_payload}"
  
  write_spool "$kind" "$session_id" "$trace_id" "$parent_id" "$skill_payload" "$agent_id" "$agent_type"
}

# --- MCP 调用专用函数 ---
# AC18: 记录 MCP 调用事件
write_mcp_spool() {
  local kind="$1"
  local session_id="$2"
  local trace_id="$3"
  local parent_id="$4"
  local server_name="$5"
  local tool_name="$6"
  local payload="$7"
  local agent_id="$8"
  local agent_type="${9}"
  
  # Build MCP-specific payload
  local mcp_payload="{\"serverName\": \"$(json_escape "$server_name")\", \"toolName\": \"$(json_escape "$tool_name")\""
  if [ -n "$payload" ]; then
    # Merge additional payload
    mcp_payload="$mcp_payload, $(echo "$payload" | sed 's/^{//;s/}$//')"
  fi
  mcp_payload="$mcp_payload}"
  
  write_spool "$kind" "$session_id" "$trace_id" "$parent_id" "$mcp_payload" "$agent_id" "$agent_type"
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

# 从 mcp__<server>__<tool> 格式提取 serverName 和 toolName
_parse_mcp_name() {
  local raw="$1"
  local without_prefix="${raw#mcp__}"
  # serverName = 从开头到第二个 __  之前
  MCP_SERVER_NAME="${without_prefix%%__*}"
  # toolName = 第二个 __ 之后
  MCP_TOOL_NAME="${without_prefix#*__}"
  # 如果 toolName 仍有 __，取最后一段
  case "$MCP_TOOL_NAME" in
    *__*) MCP_TOOL_NAME="${MCP_TOOL_NAME##*__}" ;;
  esac
  [ -z "$MCP_TOOL_NAME" ] && MCP_TOOL_NAME="${LLM_TOOL_NAME:-$raw}"
}

# ============================================================================
# Raw Debug Logging — 保存 Hook 原始输入用于调试
# 启用方式: export TRAE_DEBUG_RAW=1
# 日志位置: ~/.agent-insight/otel_data/trae/_debug_raw/<yyyy-mm-dd>.jsonl
# ============================================================================
debug_raw_input() {
  [ "${TRAE_DEBUG_RAW:-0}" = "1" ] || return 0
  local raw_input="$1"
  local hook_name="${2:-unknown}"
  local ts; ts=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
  local debug_base="${AGENT_INSIGHT_DIR:-$HOME/.agent-insight}/otel_data/trae/_debug_raw"
  local debug_file="$debug_base/$(date -u +%Y-%m-%d).jsonl"
  mkdir -p "$(dirname "$debug_file")" 2>/dev/null
  # 写入一行 JSON：元数据 + 原始输入
  python3 -c "
import os, sys, json
entry = {
    't': os.environ.get('_DBG_TS', ''),
    'hook': os.environ.get('_DBG_HOOK', ''),
    'sessionID': os.environ.get('_DBG_SID', ''),
    'raw': json.loads(sys.stdin.read()) if sys.stdin.read(1) else {}
}
" 2>/dev/null <<RAW_INPUT
$raw_input
RAW_INPUT
  # 用更简单的方式：直接把 raw_input 和元数据拼接写入
  local session_id
  session_id=$(echo "$raw_input" | json_extract_string ".session_id" 2>/dev/null || echo "")
  local entry="{\"t\":\"$ts\",\"hook\":\"$hook_name\",\"sessionID\":\"$session_id\",\"raw\":$raw_input}"
  echo "$entry" >> "$debug_file" 2>/dev/null
}
