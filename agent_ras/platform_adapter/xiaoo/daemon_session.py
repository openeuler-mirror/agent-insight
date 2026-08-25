# coding: utf-8
"""RAS-owned xiaoO Daemon session: SSE → Signal + cancel/input HostControl."""
from __future__ import annotations

import json
import logging
import threading
import uuid
from typing import Any, Callable

from platform_adapter.common.protocol_client import CallableHostControl
from platform_adapter.common.ras_client import RasClient
from platform_adapter.xiaoo.daemon_client import XiaooDaemonClient
from platform_adapter.xiaoo.hooks import build_xiaoo_ras_client
from platform_adapter.xiaoo.stream_bridge import observe_text_delta, observe_tool_after

logger = logging.getLogger(__name__)


def _parse_args_preview(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    text = str(raw or "").strip()
    if not text:
        return {}
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        return {"_preview": text[:400]}
    return value if isinstance(value, dict) else {"_preview": text[:400]}


def map_sse_event_to_observes(
    event: dict[str, Any],
    *,
    session_id: str,
    client: RasClient,
    message_ids: dict[str, str],
) -> list[dict[str, Any] | None]:
    """Map one daemon SSE event into zero or more RasClient observe results."""
    et = str(event.get("type") or "")
    out: list[dict[str, Any] | None] = []

    if et == "text_delta":
        snap = str(event.get("snapshot") or "")
        delta = str(event.get("delta") or "")
        text = snap or delta
        if not text:
            return out
        mid = message_ids.setdefault("llm_output", f"xiaoo-llm-{uuid.uuid4().hex[:16]}")
        out.append(
            observe_text_delta(
                client, session_id, text, channel="llm_output", message_id=mid
            )
        )
        return out

    if et == "thinking_delta":
        snap = str(event.get("snapshot") or "")
        delta = str(event.get("delta") or "")
        text = snap or delta
        if not text:
            return out
        mid = message_ids.setdefault(
            "llm_reasoning", f"xiaoo-llm-{uuid.uuid4().hex[:16]}"
        )
        out.append(
            observe_text_delta(
                client, session_id, text, channel="llm_reasoning", message_id=mid
            )
        )
        return out

    if et == "tool_result":
        name = str(event.get("tool_name") or "unknown")
        call_id = str(event.get("call_id") or "") or None
        is_error = bool(event.get("is_error"))
        preview = str(event.get("output_preview") or "")
        args = _parse_args_preview(event.get("args_preview"))
        result: dict[str, Any] = {
            "output": preview,
            "success": not is_error,
        }
        if is_error:
            result["error"] = preview or "tool_error"
            result["status"] = "error"
        message_ids.pop("llm_output", None)
        message_ids.pop("llm_reasoning", None)
        out.append(
            observe_tool_after(
                client,
                session_id,
                name=name,
                args=args,
                call_id=call_id,
                result=result,
                error=preview if is_error else None,
                is_error=is_error,
            )
        )
        return out

    if et == "tool_call":
        status = str(event.get("status") or "").lower()
        if status not in {"failed", "denied", "error"}:
            return out
        name = str(event.get("tool_name") or "unknown")
        call_id = str(event.get("call_id") or "") or None
        detail = str(event.get("detail") or status)
        args = _parse_args_preview(event.get("args_preview"))
        message_ids.pop("llm_output", None)
        message_ids.pop("llm_reasoning", None)
        out.append(
            observe_tool_after(
                client,
                session_id,
                name=name,
                args=args,
                call_id=call_id,
                result={"success": False, "error": detail, "status": "error"},
                error=detail,
                is_error=True,
            )
        )
        return out

    if et in {"done", "loop_end"}:
        message_ids.clear()
    return out


class DaemonRasSession:
    """Hold daemon lease + RAS client; stream SSE into SessionHub; Host via cancel/input."""

    def __init__(
        self,
        *,
        base_url: str = "http://127.0.0.1:18080",
        client_id: str | None = None,
        hello_config: dict[str, Any] | None = None,
        timeout_seconds: float = 180.0,
    ) -> None:
        self.daemon = XiaooDaemonClient(
            base_url, client_id=client_id, timeout_seconds=timeout_seconds
        )
        self.hello_config = hello_config or {}
        self._lock = threading.Lock()
        self._stop_stream = False
        self._sse_active = False
        self._pending_prompts: list[str] = []
        self._message_ids: dict[str, str] = {}
        self._last_observe: dict[str, Any] | None = None
        self.ras_sid: str | None = None

        abort_fn, notice_fn, steer_fn = self._build_host_fns()
        self.client, self.host = build_xiaoo_ras_client(
            abort_fn=abort_fn,
            notice_fn=notice_fn,
            steer_fn=steer_fn,
        )

    def _build_host_fns(
        self,
    ) -> tuple[Callable[[], Any], Callable[[str], Any], Callable[[str], Any]]:
        def abort_fn() -> dict[str, Any]:
            with self._lock:
                self._stop_stream = True
            return self.daemon.cancel()

        def steer_fn(message: str) -> dict[str, Any]:
            text = str(message or "")
            if not text.strip():
                return {"ok": False, "error": "empty_steer"}
            with self._lock:
                # Mid-stream: queue and stop so caller can drain after cancel.
                if self._stop_stream or self.daemon.runtime_id:
                    self._pending_prompts.append(text)
            # Best-effort immediate follow-up input when not inside SSE read.
            try:
                if self.daemon.runtime_id and not self._sse_active:
                    self.daemon.input_turn(text, timeout_seconds=60.0)
                    with self._lock:
                        if self._pending_prompts and self._pending_prompts[-1] == text:
                            self._pending_prompts.pop()
                    return {"ok": True}
            except Exception as exc:  # noqa: BLE001
                logger.debug("daemon steer immediate input failed: %s", exc)
                return {"ok": False, "error": str(exc)}
            return {"ok": True, "queued": True}

        def notice_fn(message: str) -> dict[str, Any]:
            text = message if str(message).startswith("[RAS]") else f"[RAS] {message}"
            return steer_fn(text)

        return abort_fn, notice_fn, steer_fn

    def open(self, **kwargs: Any) -> dict[str, Any]:
        resp = self.daemon.open(**kwargs)
        native = self.daemon.runtime_id or ""
        self.ras_sid = f"xiaoo:{native}" if native and not native.startswith("xiaoo:") else native
        assert self.ras_sid
        self.client.ensure()
        self.client.hello(self.ras_sid, "xiaoo", self.hello_config)
        return resp

    def run_turn(self, text: str, *, timeout_seconds: float | None = None) -> dict[str, Any]:
        if not self.ras_sid or not self.daemon.runtime_id:
            raise RuntimeError("call open() before run_turn()")
        with self._lock:
            self._stop_stream = False
            self._message_ids.clear()
        self._sse_active = True
        events: list[dict[str, Any]] = []
        try:

            def on_event(event: dict[str, Any]) -> None:
                events.append(event)
                results = map_sse_event_to_observes(
                    event,
                    session_id=self.ras_sid or "",
                    client=self.client,
                    message_ids=self._message_ids,
                )
                for result in results:
                    if result:
                        self._last_observe = result

            self.daemon.input_turn(
                text,
                on_event=on_event,
                timeout_seconds=timeout_seconds,
                stop_when=lambda: self._stop_stream,
            )
        finally:
            self._sse_active = False

        # Drain recovery prompts queued during abort.
        drained: list[str] = []
        with self._lock:
            pending = list(self._pending_prompts)
            self._pending_prompts.clear()
        for prompt in pending:
            try:
                self.daemon.input_turn(prompt, timeout_seconds=60.0)
                drained.append(prompt)
            except Exception as exc:  # noqa: BLE001
                logger.warning("daemon recovery input failed: %s", exc)
                return {
                    "events": events,
                    "stopped": self._stop_stream,
                    "drained": drained,
                    "error": str(exc),
                    "last_observe": self._last_observe,
                }
        return {
            "events": events,
            "stopped": self._stop_stream,
            "drained": drained,
            "last_observe": self._last_observe,
        }

    def close(self) -> dict[str, Any]:
        if self.ras_sid:
            try:
                self.client.reset(self.ras_sid)
            except Exception:  # noqa: BLE001
                pass
        return self.daemon.close()


def build_daemon_ras_session(**kwargs: Any) -> DaemonRasSession:
    return DaemonRasSession(**kwargs)


__all__ = [
    "DaemonRasSession",
    "CallableHostControl",
    "build_daemon_ras_session",
    "map_sse_event_to_observes",
]
