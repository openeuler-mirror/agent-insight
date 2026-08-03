# coding: utf-8
"""OpenClaw L3 HostControl skeleton — map wire actions to host APIs."""
from __future__ import annotations

import logging
import uuid
from typing import Any, Callable

logger = logging.getLogger(__name__)


def _msg_id() -> str:
    return f"msg_{uuid.uuid4().hex[:26]}"


class OpenClawHostControl:
    """Thin Host for OpenClaw. Inject callables when native APIs are available."""

    def __init__(
        self,
        *,
        abort_fn: Callable[[], Any] | None = None,
        notice_fn: Callable[[str], Any] | None = None,
        steer_fn: Callable[[str], Any] | None = None,
    ) -> None:
        self._abort_fn = abort_fn
        self._notice_fn = notice_fn
        self._steer_fn = steer_fn

    def requestAbortStream(self) -> dict[str, Any]:
        return self.request_abort_stream()

    def request_abort_stream(self) -> dict[str, Any]:
        if self._abort_fn is None:
            return {"ok": False, "error": "openclaw abort_fn not wired", "channel": "openclaw.abort"}
        try:
            self._abort_fn()
            return {"ok": True, "channel": "openclaw.abort"}
        except Exception as exc:
            logger.warning("openclaw abort failed", exc_info=True)
            return {"ok": False, "error": str(exc), "channel": "openclaw.abort"}

    def emitUserNotice(self, message: str) -> dict[str, Any]:
        return self.emit_user_notice(message)

    def emit_user_notice(self, message: str) -> dict[str, Any]:
        if self._notice_fn is None:
            logger.warning("openclaw notice_fn not wired chars=%s", len(message or ""))
            return {"ok": False, "error": "openclaw notice_fn not wired", "channel": "openclaw.notice"}
        try:
            self._notice_fn(message)
            return {
                "ok": True,
                "channel": "openclaw.notice",
                "delivery_anchor": {"message_id": _msg_id(), "channel": "ras_notice"},
            }
        except Exception as exc:
            return {"ok": False, "error": str(exc), "channel": "openclaw.notice"}

    def pushSteering(self, message: str) -> dict[str, Any]:
        return self.push_steering(message)

    def push_steering(self, message: str) -> dict[str, Any]:
        if self._steer_fn is None:
            return {"ok": False, "error": "openclaw steer_fn not wired", "channel": "openclaw.steer"}
        try:
            self._steer_fn(message)
            return {
                "ok": True,
                "channel": "openclaw.steer",
                "delivery_anchor": {"message_id": _msg_id(), "channel": "ras_steering"},
            }
        except Exception as exc:
            return {"ok": False, "error": str(exc), "channel": "openclaw.steer"}
