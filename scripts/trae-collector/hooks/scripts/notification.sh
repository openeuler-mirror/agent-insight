#!/bin/bash
# Copyright (c) 2026 Huawei Technologies Co., Ltd.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# ============================================================================
# Agent Insight TRAE Collector — Notification Handler
# Triggered async when tool waits for user confirm or task completes.
# stdin: { "session_id": "...", "hook_event_name": "Notification",
#          "notification_type": "...", "message": "...", "tool_use_id": "..." }
# stdout: ignored (async event)
# ============================================================================
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/../lib/common.sh"

INPUT=$(cat)
debug_raw_input "$INPUT" "Notification"
SESSION_ID=$(echo "$INPUT" | json_extract_string ".session_id")
AGENT_ID=$(echo "$INPUT" | json_extract_string ".agent_id")
AGENT_TYPE=$(echo "$INPUT" | json_extract_string ".agent_type")
NOTIF_TYPE=$(echo "$INPUT" | json_extract_string ".notification_type")
MESSAGE=$(echo "$INPUT" | json_extract_string ".message")
TOOL_USE_ID=$(echo "$INPUT" | json_extract_string ".tool_use_id")

[ -z "$SESSION_ID" ] && exit 0

SAFE_MSG=$(truncate_str "$MESSAGE" 500)
ESCAPED_MSG=$(json_escape "$SAFE_MSG")

write_spool \
  "agent.notification" \
  "$SESSION_ID" \
  "${SESSION_ID}" \
  "" \
  "{\"notificationType\": \"$(json_escape "$NOTIF_TYPE")\", \"message\": \"$ESCAPED_MSG\", \"tool_use_id\": \"$(json_escape "$TOOL_USE_ID")\"}" \
  "$AGENT_ID" \
  "$AGENT_TYPE"

exit 0
