# coding: utf-8
# Copyright (c) Huawei Technologies Co., Ltd. 2026. All rights reserved.
"""Host-facing control surface for Agent RAS recovery side effects.

Core Monitor/Recovery call this protocol only — never openjiuwen types.
"""
from __future__ import annotations

from typing import Any, Protocol, runtime_checkable


@runtime_checkable
class HostControl(Protocol):
    """Abort / steer / notice / stream write — implemented per platform."""

    def request_abort_stream(self) -> None:
        """Request cooperative abort of the in-flight LLM stream."""
        ...

    def push_steering(self, message: str) -> None:
        """Queue a steering / self-correction message for the next turn."""
        ...

    def request_force_finish(self, payload: dict[str, Any]) -> None:
        """Force-finish the current invoke with the given result payload."""
        ...

    async def emit_user_notice(self, message: str) -> None:
        """Emit a user-visible recovery / warning notice."""
        ...

    async def emit_stream_error(self, message: str) -> None:
        """Emit an error-typed stream event (critical terminate path)."""
        ...

    async def write_stream_content(self, chunk_type: str, content: str) -> None:
        """Write buffered content back to the session stream (flush path)."""
        ...


class NoOpHostControl:
    """Fail-open host when no platform control is bound."""

    def request_abort_stream(self) -> None:
        return None

    def push_steering(self, message: str) -> None:
        _ = message

    def request_force_finish(self, payload: dict[str, Any]) -> None:
        _ = payload

    async def emit_user_notice(self, message: str) -> None:
        _ = message

    async def emit_stream_error(self, message: str) -> None:
        _ = message

    async def write_stream_content(self, chunk_type: str, content: str) -> None:
        _ = chunk_type, content


__all__ = ["HostControl", "NoOpHostControl"]
