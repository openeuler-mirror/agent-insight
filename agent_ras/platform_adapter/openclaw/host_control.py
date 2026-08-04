# coding: utf-8
"""OpenClaw L3 HostControl — CallableHostControl bound to platform=openclaw."""
from __future__ import annotations

from typing import Any, Callable

from platform_adapter.common.protocol_client import CallableHostControl


class OpenClawHostControl(CallableHostControl):
    def __init__(
        self,
        *,
        abort_fn: Callable[[], Any] | None = None,
        notice_fn: Callable[[str], Any] | None = None,
        steer_fn: Callable[[str], Any] | None = None,
    ) -> None:
        super().__init__(
            platform="openclaw",
            abort_fn=abort_fn,
            notice_fn=notice_fn,
            steer_fn=steer_fn,
        )


__all__ = ["OpenClawHostControl", "CallableHostControl"]
