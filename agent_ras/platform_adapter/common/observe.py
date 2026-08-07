# coding: utf-8
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
) -> dict[str, Any] | None:
    payload: dict[str, Any] = {
        "platform": platform,
        "kind": "tool",
        "tool": {
            "name": name,
            "phase": "after",
            "args": args or {},
        },
    }
    if call_id:
        payload["trace_anchor"] = {"call_id": call_id, "channel": "tool_call"}
    return client.observe(session_id, payload)


__all__ = ["observe_assistant_text", "observe_tool_after"]
