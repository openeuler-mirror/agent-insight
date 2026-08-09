# coding: utf-8
"""Shared in-process RAS client for Python hosts."""
from __future__ import annotations

import json
import logging
from typing import Any, Callable

from ras_runtime import call as embed_call

logger = logging.getLogger(__name__)

ActionHandler = Callable[[str, list[dict[str, Any]], dict[str, Any] | None], None]


class RasClient:
    """Thin synchronous wrapper around the in-process ``ras_runtime`` facade."""

    def __init__(
        self,
        *,
        on_actions: ActionHandler | None = None,
        enabled: bool = True,
        **_unused: Any,
    ) -> None:
        del _unused
        self.enabled = bool(enabled)
        self.on_actions = on_actions
        self.transport = "inproc"
        self._ready = False

    @property
    def base_url(self) -> None:
        return None

    def _call(
        self,
        op: str,
        session_id: str,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        if not self.enabled:
            return None
        try:
            result = json.loads(
                embed_call(op, session_id, json.dumps(payload or {}, ensure_ascii=False))
            )
        except Exception:
            logger.debug("inproc RAS call failed op=%s", op, exc_info=True)
            self._ready = False
            return None
        if result.get("error"):
            logger.debug("inproc RAS returned error op=%s error=%s", op, result["error"])
            return None
        self._ready = True
        return result

    def ensure(self) -> bool:
        result = self._call("health", "", {})
        self._ready = bool(result and result.get("status") == "ok")
        return self._ready

    def hello(
        self,
        session_id: str,
        platform: str,
        config: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        return self._call(
            "hello",
            session_id,
            {"platform": platform, "config": config or {}},
        )

    def observe(
        self,
        session_id: str,
        payload: dict[str, Any],
    ) -> dict[str, Any] | None:
        result = self._call("observe", session_id, payload)
        if result and self.on_actions and result.get("actions"):
            self.on_actions(
                session_id,
                list(result.get("actions") or []),
                result.get("anomaly"),
            )
        return result

    def reset(self, session_id: str) -> None:
        self._call("reset", session_id, {})

    def report_action_result(
        self,
        session_id: str,
        result: dict[str, Any],
    ) -> bool:
        response = self._call(
            "action_result",
            session_id,
            {
                "action": result.get("action"),
                "ok": bool(result.get("ok")),
                "channel": result.get("channel"),
                "error": result.get("error"),
                "message": result.get("message"),
                "trace_anchor": result.get("trace_anchor"),
                "delivery_anchor": result.get("delivery_anchor"),
            },
        )
        return bool(response and response.get("ok"))

    def skill_result(
        self,
        session_id: str,
        payload: dict[str, Any],
    ) -> dict[str, Any] | None:
        result = self._call("skill_result", session_id, payload)
        if result and self.on_actions and result.get("actions"):
            self.on_actions(
                session_id,
                list(result.get("actions") or []),
                result.get("anomaly"),
            )
        return result

    def bye(self, session_id: str) -> None:
        self._call("bye", session_id, {})


__all__ = ["RasClient", "ActionHandler"]
