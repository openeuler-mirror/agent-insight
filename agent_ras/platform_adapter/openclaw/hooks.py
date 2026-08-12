# coding: utf-8
"""OpenClaw inproc hooks — thin wrapper around shared protocol factory."""
from __future__ import annotations

from typing import Any, Callable

from platform_adapter.common.protocol_client import (
    CallableHostControl,
    build_protocol_ras_client,
)

# Back-compat alias for INSTALL / external imports.
OpenClawHostControl = CallableHostControl


def build_openclaw_ras_client(
    *,
    abort_fn: Callable[[], Any] | None = None,
    notice_fn: Callable[[str], Any] | None = None,
    steer_fn: Callable[[str], Any] | None = None,
) -> tuple[Any, CallableHostControl]:
    """Create a RasClient whose on_actions dispatch through CallableHostControl.

    Hosts should call ``client.hello(session_id, \"openclaw\")`` then ``observe``.
    """
    return build_protocol_ras_client(
        platform="openclaw",
        abort_fn=abort_fn,
        notice_fn=notice_fn,
        steer_fn=steer_fn,
    )
