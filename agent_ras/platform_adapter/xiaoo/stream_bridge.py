# coding: utf-8
"""xiaoO thin wrappers over common observe helpers."""
from __future__ import annotations

from typing import Any

from platform_adapter.common.observe import (
    observe_assistant_text,
    observe_tool_after as _observe_tool_after,
)
from platform_adapter.common.ras_client import RasClient


def observe_text_delta(
    client: RasClient,
    session_id: str,
    text: str,
    *,
    channel: str = "llm_output",
    message_id: str | None = None,
) -> dict[str, Any] | None:
    return observe_assistant_text(
        client,
        session_id,
        text,
        platform="xiaoo",
        channel=channel,
        message_id=message_id,
    )


def observe_tool_after(
    client: RasClient,
    session_id: str,
    *,
    name: str,
    args: dict[str, Any] | None = None,
    call_id: str | None = None,
    result: Any | None = None,
    error: str | None = None,
    is_error: bool = False,
) -> dict[str, Any] | None:
    return _observe_tool_after(
        client,
        session_id,
        platform="xiaoo",
        name=name,
        args=args,
        call_id=call_id,
        result=result,
        error=error,
        is_error=is_error,
    )


__all__ = ["observe_text_delta", "observe_tool_after"]
