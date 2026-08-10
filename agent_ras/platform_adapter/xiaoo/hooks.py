# coding: utf-8
"""xiaoO protocol inproc hooks — thin L3 over shared factory + Host callables.

Host delivery modes:
  - Default: ``ras_control.sock`` (gateway local cancel/pending) when sock exists.
  - Daemon: use ``DaemonRasSession`` / ``build_xiaoo_daemon_host_fns`` so abort →
    ``POST .../runtimes/cancel`` and notice/steer → ``.../input`` under the same
    lease ``client_id``. Stock master has no LoopEventSink plugin mount; mid-stream
    thinking + recovery must hold the Daemon SSE lease.
"""
from __future__ import annotations

import logging
from typing import Any, Callable

from platform_adapter.common.protocol_client import (
    CallableHostControl,
    build_protocol_ras_client,
)
from platform_adapter.common.ras_client import RasClient
from platform_adapter.common.transport.subprocess_ipc import send_host_control

logger = logging.getLogger(__name__)


def _delivery_result(op: str, rid: str, res: dict[str, Any]) -> dict[str, Any]:
    if not res.get("delivered"):
        logger.warning("xiaoo %s: host control sock unavailable session=%s", op, rid)
        return {"ok": False, "error": res.get("error") or "host control sock unavailable"}
    ack = res.get("ack")
    if not isinstance(ack, dict):
        return {"ok": False, "error": "no_ack: gateway gave no execution confirmation"}
    return {
        "ok": bool(ack.get("ok")),
        "error": ack.get("error") if not ack.get("ok") else None,
    }


def build_xiaoo_host_fns(
    *,
    session_id: str,
    notice_as_steer: bool = True,
) -> tuple[Callable[[], Any], Callable[[str], Any], Callable[[str], Any]]:
    """Map wire Host methods to gateway local control via ``ras_control.sock``.

    Prefer ``DaemonRasSession`` when running against stock master Daemon (no
    private gateway injection). Each fn returns delivery/ack outcome.
    """
    rid = str(session_id)

    def abort_fn() -> dict[str, Any]:
        return _delivery_result("abort", rid, send_host_control("abort", rid))

    def steer_fn(message: str) -> dict[str, Any]:
        return _delivery_result("steer", rid, send_host_control("steer", rid, message=message))

    def notice_fn(message: str) -> dict[str, Any]:
        text = f"[RAS] {message}" if notice_as_steer else message
        if notice_as_steer:
            return steer_fn(text)
        return _delivery_result("notice", rid, send_host_control("notice", rid, message=text))

    return abort_fn, notice_fn, steer_fn


def build_xiaoo_daemon_host_fns(
    *,
    cancel_fn: Callable[[], dict[str, Any]],
    input_fn: Callable[[str], dict[str, Any]],
    notice_as_steer: bool = True,
) -> tuple[Callable[[], Any], Callable[[str], Any], Callable[[str], Any]]:
    """Host callables backed by Daemon ``cancel`` + ``input`` (same lease)."""

    def abort_fn() -> dict[str, Any]:
        return cancel_fn()

    def steer_fn(message: str) -> dict[str, Any]:
        return input_fn(message)

    def notice_fn(message: str) -> dict[str, Any]:
        text = f"[RAS] {message}" if notice_as_steer else message
        return input_fn(text)

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
    "build_xiaoo_daemon_host_fns",
]
