# coding: utf-8
"""xiaoO L3 HostControl — CallableHostControl bound to platform=xiaoo."""
from __future__ import annotations

from typing import Any, Callable

from platform_adapter.common.protocol_client import CallableHostControl


class XiaooHostControl(CallableHostControl):
    def __init__(
        self,
        *,
        abort_fn: Callable[[], Any] | None = None,
        notice_fn: Callable[[str], Any] | None = None,
        steer_fn: Callable[[str], Any] | None = None,
    ) -> None:
        super().__init__(
            platform="xiaoo",
            abort_fn=abort_fn,
            notice_fn=notice_fn,
            steer_fn=steer_fn,
        )


__all__ = ["XiaooHostControl", "CallableHostControl"]
