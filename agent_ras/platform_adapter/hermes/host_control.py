# coding: utf-8
"""Hermes L3 HostControl skeleton — map wire actions to host APIs."""
from __future__ import annotations

import logging
import uuid
from typing import Any, Callable

logger = logging.getLogger(__name__)


def _msg_id() -> str:
    return f"msg_{uuid.uuid4().hex[:26]}"


class HermesHostControl:
    """Thin Host for Hermes. Inject callables when native APIs are available."""

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
            return {"ok": False, "error": "hermes abort_fn not wired", "channel": "hermes.abort"}
        try:
            self._abort_fn()
            return {"ok": True, "channel": "hermes.abort"}
        except Exception as exc:
            logger.warning("hermes abort failed", exc_info=True)
            return {"ok": False, "error": str(exc), "channel": "hermes.abort"}

    def emitUserNotice(self, message: str) -> dict[str, Any]:
        return self.emit_user_notice(message)

    def emit_user_notice(self, message: str) -> dict[str, Any]:
        if self._notice_fn is None:
            logger.warning("hermes notice_fn not wired chars=%s", len(message or ""))
            return {"ok": False, "error": "hermes notice_fn not wired", "channel": "hermes.notice"}
        try:
            self._notice_fn(message)
            return {
                "ok": True,
                "channel": "hermes.notice",
                "delivery_anchor": {"message_id": _msg_id(), "channel": "ras_notice"},
            }
        except Exception as exc:
            return {"ok": False, "error": str(exc), "channel": "hermes.notice"}

    def pushSteering(self, message: str) -> dict[str, Any]:
        return self.push_steering(message)

    def push_steering(self, message: str) -> dict[str, Any]:
        if self._steer_fn is None:
            return {"ok": False, "error": "hermes steer_fn not wired", "channel": "hermes.steer"}
        try:
            self._steer_fn(message)
            return {
                "ok": True,
                "channel": "hermes.steer",
                "delivery_anchor": {"message_id": _msg_id(), "channel": "ras_steering"},
            }
        except Exception as exc:
            return {"ok": False, "error": str(exc), "channel": "hermes.steer"}
