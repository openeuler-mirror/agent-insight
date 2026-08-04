# coding: utf-8
"""xiaoO protocol inproc hooks — thin L3 over shared factory + Host callables."""
from __future__ import annotations

import logging
from typing import Any, Callable

from platform_adapter.common.protocol_client import (
    CallableHostControl,
    build_protocol_ras_client,
)
from platform_adapter.common.ras_client import RasClient
from ras_embed.ipc import publish_host_control

logger = logging.getLogger(__name__)


def build_xiaoo_host_fns(
    *,
    session_id: str,
    notice_as_steer: bool = True,
) -> tuple[Callable[[], Any], Callable[[str], Any], Callable[[str], Any]]:
    """Map wire Host methods to gateway local control (cancel / pending).

    Delivery goes through ``ras_control.sock`` (xiaoO shared listens). No HTTP.
    """
    rid = str(session_id)

    def abort_fn() -> None:
        if not publish_host_control("abort", rid):
            logger.warning("xiaoo abort: host control sock unavailable session=%s", rid)

    def steer_fn(message: str) -> None:
        if not publish_host_control("steer", rid, message=message):
            logger.warning("xiaoo steer: host control sock unavailable session=%s", rid)

    def notice_fn(message: str) -> None:
        text = f"[RAS] {message}" if notice_as_steer else message
        if notice_as_steer:
            steer_fn(text)
            return
        if not publish_host_control("notice", rid, message=text):
            logger.warning("xiaoo notice: host control sock unavailable session=%s", rid)

    return abort_fn, notice_fn, steer_fn


def build_xiaoo_ras_client(
    *,
    abort_fn: Callable[[], Any] | None = None,
    notice_fn: Callable[[str], Any] | None = None,
    steer_fn: Callable[[str], Any] | None = None,
    session_id: str | None = None,
) -> tuple[RasClient, CallableHostControl]:
    """Create RasClient for xiaoO (protocol inproc)."""
    if abort_fn is None and notice_fn is None and steer_fn is None:
        if session_id:
            abort_fn, notice_fn, steer_fn = build_xiaoo_host_fns(session_id=session_id)
        else:
            logger.debug("xiaoo Host fns unwired: pass abort/notice/steer or session_id")

    return build_protocol_ras_client(
        platform="xiaoo",
        abort_fn=abort_fn,
        notice_fn=notice_fn,
        steer_fn=steer_fn,
    )


__all__ = [
    "build_xiaoo_ras_client",
    "build_xiaoo_host_fns",
]
