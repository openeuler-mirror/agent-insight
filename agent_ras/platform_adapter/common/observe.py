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
    """Push one assistant text/reasoning chunk into SessionHub."""
    payload: dict[str, Any] = {
        "platform": platform,
        "kind": "assistant_text",
        "channel": channel,
        "text": text,
        "mode": mode,
    }
    if message_id:
        payload["trace_anchor"] = {
            "message_id": message_id,
            "channel": channel,
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
