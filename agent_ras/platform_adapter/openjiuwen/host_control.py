# coding: utf-8
# Copyright (c) Huawei Technologies Co., Ltd. 2026. All rights reserved.
"""openjiuwen HostControl — wraps AgentCallbackContext."""
from __future__ import annotations

import logging
from typing import Any

from openjiuwen.core.single_agent.rail.base import AgentCallbackContext

from core.host_control import HostControl
from platform_adapter.common.insight_anomaly_reporter import allocate_delivery_message_id

logger = logging.getLogger(__name__)
_USER_NOTICE_STREAM_TYPE = "retry_notification"


class JiuwenHostControl:
    """HostControl backed by openjiuwen ``AgentCallbackContext``."""

    def __init__(self, ctx: AgentCallbackContext) -> None:
        self._ctx = ctx

    def request_abort_stream(self) -> dict[str, Any]:
        # Idempotent: skip if abort was already requested (finalize re-enter).
        if bool(getattr(self._ctx, "has_abort_stream_request", False)):
            return {"ok": True, "channel": "abort.idempotent"}
        request_abort = getattr(self._ctx, "request_abort_stream", None)
        if callable(request_abort):
            request_abort()
            return {"ok": True, "channel": "abort_stream"}
        return {"ok": False, "error": "request_abort_stream unavailable", "channel": "abort_stream"}

    def push_steering(self, message: str) -> dict[str, Any]:
        queue = getattr(self._ctx, "steering_queue", None)
        if queue is None:
            logger.warning(
                "push_steering skipped: steering_queue is None chars=%s",
                len(message or ""),
            )
            return {"ok": False, "error": "steering_queue is None", "channel": "steering"}
        self._ctx.push_steering(message)
        message_id = allocate_delivery_message_id()
        return {
            "ok": True,
            "channel": "steering_queue",
            "delivery_anchor": {
                "message_id": message_id,
                "channel": "ras_steering",
            },
        }

    def request_force_finish(self, payload: dict[str, Any]) -> None:
        self._ctx.request_force_finish(payload)

    async def emit_user_notice(self, message: str) -> dict[str, Any]:
        session = getattr(self._ctx, "session", None)
        if session is None:
            return {"ok": False, "error": "session is None", "channel": "stream"}
        try:
            from openjiuwen.core.session.stream import OutputSchema

            notice_text = f"\n\n⚠️ {message}\n\n"
            await session.write_stream(
                OutputSchema(
                    type=_USER_NOTICE_STREAM_TYPE,
                    index=-1,
                    payload={
                        "output": {
                            "output": notice_text,
                            "result_type": "text",
                        },
                    },
                )
            )
            message_id = allocate_delivery_message_id()
            return {
                "ok": True,
                "channel": _USER_NOTICE_STREAM_TYPE,
                "delivery_anchor": {
                    "message_id": message_id,
                    "channel": "ras_notice",
                },
            }
        except Exception as exc:
            logger.warning("emit_user_notice failed", exc_info=True)
            return {"ok": False, "error": str(exc), "channel": "stream"}

    async def emit_stream_error(self, message: str) -> None:
        session = getattr(self._ctx, "session", None)
        if session is None:
            return
        try:
            from openjiuwen.core.session.stream import OutputSchema

            await session.write_stream(
                OutputSchema(
                    type="error",
                    index=0,
                    payload={"error": message, "message": message},
                )
            )
        except Exception:
            logger.warning("emit_stream_error failed", exc_info=True)

    async def write_stream_content(self, chunk_type: str, content: str) -> None:
        session = getattr(self._ctx, "session", None)
        if session is None or not content:
            return
        try:
            from openjiuwen.core.session.stream import OutputSchema

            await session.write_stream(
                OutputSchema(
                    type=chunk_type,
                    index=0,
                    payload={"content": content},
                )
            )
        except Exception:
            logger.warning("write_stream_content failed", exc_info=True)


def host_control_from_ctx(ctx: AgentCallbackContext | None) -> HostControl:
    from core.host_control import NoOpHostControl

    if ctx is None:
        return NoOpHostControl()
    return JiuwenHostControl(ctx)


__all__ = ["JiuwenHostControl", "host_control_from_ctx"]
