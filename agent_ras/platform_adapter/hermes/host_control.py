# coding: utf-8
"""Hermes L3 HostControl — CallableHostControl bound to platform=hermes."""
from __future__ import annotations

from typing import Any, Callable

from platform_adapter.common.protocol_client import CallableHostControl


class HermesHostControl(CallableHostControl):
    def __init__(
        self,
        *,
        abort_fn: Callable[[], Any] | None = None,
        notice_fn: Callable[[str], Any] | None = None,
        steer_fn: Callable[[str], Any] | None = None,
    ) -> None:
        super().__init__(
            platform="hermes",
            abort_fn=abort_fn,
            notice_fn=notice_fn,
            steer_fn=steer_fn,
        )


__all__ = ["HermesHostControl", "CallableHostControl"]
