# coding: utf-8
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

"""Shared protocol-path observe helpers (platform-neutral)."""
from __future__ import annotations

from typing import Any


def observe_assistant_text(
    client: Any,
    session_id: str,
    text: str,
    *,
    platform: str,
    channel: str = "llm_output",
    message_id: str | None = None,
    mode: str = "snapshot",
) -> dict[str, Any] | None:
    """Push one assistant text/reasoning chunk into SessionHub.

    Always attaches an LLM ``trace_anchor`` (message_id + llm channel). Callers
    should pass a turn-stable ``message_id``; when omitted a session-scoped
    placeholder is used so SessionHub refreshes the LLM bucket and never leaves
    a stale tool ``call_id`` as the only anchor for thinking-loop anomalies.
    """
    mid = (message_id or "").strip() or f"{platform}-llm-{session_id}-{channel}"
    payload: dict[str, Any] = {
        "platform": platform,
        "kind": "assistant_text",
        "channel": channel,
        "text": text,
        "mode": mode,
        "trace_anchor": {
            "message_id": mid,
            "channel": channel,
        },
    }
    return client.observe(session_id, payload)


def observe_tool_after(
    client: Any,
    session_id: str,
    *,
    platform: str,
    name: str,
    args: dict[str, Any] | None = None,
    call_id: str | None = None,
    result: Any | None = None,
    error: str | None = None,
    is_error: bool = False,
) -> dict[str, Any] | None:
    tool: dict[str, Any] = {
        "name": name,
        "phase": "after",
        "args": args or {},
    }
    if result is not None:
        tool["result"] = result
    err = error
    if err is None and is_error:
        err = "tool_error"
    if err is not None:
        tool["error"] = err
        if result is None:
            tool["result"] = {"success": False, "error": err, "status": "error"}
    payload: dict[str, Any] = {
        "platform": platform,
        "kind": "tool",
        "tool": tool,
    }
    if call_id:
        payload["trace_anchor"] = {"call_id": call_id, "channel": "tool_call"}
    return client.observe(session_id, payload)


__all__ = ["observe_assistant_text", "observe_tool_after"]
