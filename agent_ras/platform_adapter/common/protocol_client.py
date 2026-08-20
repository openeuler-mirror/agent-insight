# coding: utf-8
"""Shared protocol-path L3 helpers: CallableHostControl + RasClient factory.

Wire delivery mirrors JS ``applyActions`` (message as decided by core; no
re-wrapping). New platforms should use ``build_protocol_ras_client`` instead of
copying per-platform stubs.
"""
from __future__ import annotations

import logging
from typing import Any, Callable

from platform_adapter.common.ras_client import RasClient

logger = logging.getLogger(__name__)

AbortFn = Callable[[], Any]
NoticeFn = Callable[[str], Any]
SteerFn = Callable[[str], Any]


class CallableHostControl:
    """Thin WireHost: inject abort/notice/steer callables per platform."""

    def __init__(
        self,
        *,
        platform: str,
        abort_fn: AbortFn | None = None,
        notice_fn: NoticeFn | None = None,
        steer_fn: SteerFn | None = None,
    ) -> None:
        self.platform = str(platform or "").strip() or "unknown"
        self._abort_fn = abort_fn
        self._notice_fn = notice_fn
        self._steer_fn = steer_fn

    def requestAbortStream(self) -> dict[str, Any]:
        return self.request_abort_stream()

    @staticmethod
    def _fn_outcome(raw: Any, channel: str) -> dict[str, Any] | None:
        """fn 返回 {"ok": ...} 时以 fn 自报结果为准（禁止无脑 ok=True）。"""
        if isinstance(raw, dict) and "ok" in raw:
            out: dict[str, Any] = {"ok": bool(raw.get("ok")), "channel": channel}
            if raw.get("error"):
                out["error"] = raw["error"]
            anchor = raw.get("delivery_anchor")
            if isinstance(anchor, dict) and anchor:
                out["delivery_anchor"] = anchor
            return out
        return None

    def request_abort_stream(self) -> dict[str, Any]:
        channel = f"{self.platform}.abort"
        if self._abort_fn is None:
            return {"ok": False, "error": f"{self.platform} abort_fn not wired", "channel": channel}
        try:
            outcome = self._fn_outcome(self._abort_fn(), channel)
            return outcome if outcome is not None else {"ok": True, "channel": channel}
        except Exception as exc:
            logger.warning("%s abort failed", self.platform, exc_info=True)
            return {"ok": False, "error": str(exc), "channel": channel}

    def emitUserNotice(self, message: str) -> dict[str, Any]:
        return self.emit_user_notice(message)

    def emit_user_notice(self, message: str) -> dict[str, Any]:
        channel = f"{self.platform}.notice"
        if self._notice_fn is None:
            logger.warning(
                "%s notice_fn not wired chars=%s", self.platform, len(message or "")
            )
            return {"ok": False, "error": f"{self.platform} notice_fn not wired", "channel": channel}
        try:
            outcome = self._fn_outcome(self._notice_fn(message), channel)
            if outcome is not None:
                return outcome
            return {"ok": True, "channel": channel}
        except Exception as exc:
            return {"ok": False, "error": str(exc), "channel": channel}

    def pushSteering(self, message: str) -> dict[str, Any]:
        return self.push_steering(message)

    def push_steering(self, message: str) -> dict[str, Any]:
        channel = f"{self.platform}.steer"
        if self._steer_fn is None:
            return {"ok": False, "error": f"{self.platform} steer_fn not wired", "channel": channel}
        try:
            outcome = self._fn_outcome(self._steer_fn(message), channel)
            if outcome is not None:
                return outcome
            return {"ok": True, "channel": channel}
        except Exception as exc:
            return {"ok": False, "error": str(exc), "channel": channel}


_WIRE_TO_METHOD = {
    "abort_stream": "request_abort_stream",
    "emit_notice": "emit_user_notice",
    "push_steering": "push_steering",
}


def apply_wire_actions(
    host: Any,
    actions: list[dict[str, Any]] | None,
    *,
    on_result: Callable[[dict[str, Any]], Any] | None = None,
) -> list[dict[str, Any]]:
    """Sync wire dispatcher aligned with JS ``applyActions`` / HostControl."""
    results: list[dict[str, Any]] = []
    for action in actions or []:
        if not isinstance(action, dict):
            continue
        atype = str(action.get("type") or "")
        message = None if atype == "abort_stream" else str(action.get("message") or "")
        method_name = _WIRE_TO_METHOD.get(atype)
        result: dict[str, Any] = {
            "action": atype or "unknown",
            "ok": False,
            "error": "unknown action",
            **({"message": message} if message else {}),
        }
        if not method_name:
            logger.error("apply_wire_actions: unknown wire action %r", atype)
        else:
            method = getattr(host, method_name, None)
            if not callable(method):
                result = {
                    "action": atype,
                    "ok": False,
                    "error": f"host missing {method_name}",
                    **({"message": message} if message else {}),
                }
                logger.error("apply_wire_actions: host missing %s", method_name)
            else:
                try:
                    raw = method() if atype == "abort_stream" else method(message)
                    if isinstance(raw, dict) and "ok" in raw:
                        result = {
                            "action": atype,
                            "ok": bool(raw.get("ok")),
                            "channel": raw.get("channel"),
                            "error": raw.get("error"),
                            **({"message": message} if message else {}),
                            **(
                                {"delivery_anchor": raw["delivery_anchor"]}
                                if raw.get("delivery_anchor")
                                else {}
                            ),
                        }
                    else:
                        result = {
                            "action": atype,
                            "ok": True,
                            **({"message": message} if message else {}),
                        }
                except Exception as exc:
                    result = {
                        "action": atype,
                        "ok": False,
                        "error": str(exc),
                        **({"message": message} if message else {}),
                    }
                    logger.error("apply_wire_actions: %s failed", atype, exc_info=True)
        results.append(result)
        if on_result is not None:
            try:
                on_result(result)
            except Exception:
                logger.error("apply_wire_actions: on_result failed", exc_info=True)
    return results


def build_protocol_ras_client(
    *,
    platform: str,
    abort_fn: AbortFn | None = None,
    notice_fn: NoticeFn | None = None,
    steer_fn: SteerFn | None = None,
    report_results: bool = True,
) -> tuple[RasClient, CallableHostControl]:
    """Create RasClient whose on_actions dispatch through CallableHostControl."""
    host = CallableHostControl(
        platform=platform,
        abort_fn=abort_fn,
        notice_fn=notice_fn,
        steer_fn=steer_fn,
    )

    def on_actions(
        session_id: str,
        actions: list[dict[str, Any]],
        anomaly: Any,
    ) -> None:
        del anomaly

        def _on_result(result: dict[str, Any]) -> None:
            if not report_results:
                return
            client.report_action_result(session_id, result)

        try:
            apply_wire_actions(host, actions, on_result=_on_result)
        finally:
            client.flush(session_id)

    client = RasClient(on_actions=on_actions)
    return client, host


__all__ = [
    "CallableHostControl",
    "apply_wire_actions",
    "build_protocol_ras_client",
]
