# coding: utf-8
"""xiaoO master Daemon HTTP/SSE client (RAS-owned lease).

Endpoints (stock xiaoO):
  POST /api/v1/runtimes/open
  POST /api/v1/runtimes/input   (Accept: text/event-stream)
  POST /api/v1/runtimes/cancel
  POST /api/v1/runtimes/close
"""
from __future__ import annotations

import json
import logging
import uuid
from typing import Any, Callable, Iterator
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

logger = logging.getLogger(__name__)

SseEventHandler = Callable[[dict[str, Any]], None]


class XiaooDaemonClient:
    """Lease-holding HTTP client for xiaoO daemon control plane."""

    def __init__(
        self,
        base_url: str = "http://127.0.0.1:18080",
        *,
        client_id: str | None = None,
        timeout_seconds: float = 60.0,
    ) -> None:
        self.base_url = str(base_url or "").rstrip("/") or "http://127.0.0.1:18080"
        self.client_id = (client_id or "").strip() or f"agent-ras-{uuid.uuid4().hex[:12]}"
        self.timeout_seconds = float(timeout_seconds)
        self.runtime_id: str | None = None
        self.conversation_id: str | None = None
        self.sender_id: str = "agent-ras"

    def open(
        self,
        *,
        runtime_id: str | None = None,
        conversation_id: str | None = None,
        sender_id: str | None = None,
        title: str | None = None,
        model: str | None = None,
        workspace: str | None = None,
    ) -> dict[str, Any]:
        rid = (runtime_id or "").strip() or f"ras-{uuid.uuid4().hex[:16]}"
        cid = (conversation_id or "").strip() or rid
        sid = (sender_id or "").strip() or self.sender_id
        body: dict[str, Any] = {
            "runtime_id": rid,
            "conversation_id": cid,
            "sender_id": sid,
            "client_id": self.client_id,
            "entry": {"title": title or rid},
        }
        if model and str(model).strip():
            body["llm"] = {"model": str(model).strip()}
        if workspace and str(workspace).strip():
            body["workspace"] = str(workspace).strip()
        resp = self.http_json("POST", f"{self.base_url}/api/v1/runtimes/open", body)
        self.runtime_id = str(
            resp.get("runtime_id")
            or resp.get("session_id")
            or resp.get("id")
            or rid
        )
        self.conversation_id = cid
        self.sender_id = sid
        return resp

    def cancel(self, runtime_id: str | None = None) -> dict[str, Any]:
        rid = (runtime_id or self.runtime_id or "").strip()
        if not rid:
            return {"ok": False, "error": "no_runtime_id"}
        try:
            resp = self.http_json(
                "POST",
                f"{self.base_url}/api/v1/runtimes/cancel",
                {"runtime_id": rid, "client_id": self.client_id},
            )
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": str(exc)}
        # Cancelled event or plain ok
        if isinstance(resp, dict) and resp.get("error"):
            return {"ok": False, "error": str(resp.get("error")), "raw": resp}
        return {"ok": True, "raw": resp}

    def close(self, runtime_id: str | None = None) -> dict[str, Any]:
        rid = (runtime_id or self.runtime_id or "").strip()
        if not rid:
            return {"ok": False, "error": "no_runtime_id"}
        try:
            return self.http_json(
                "POST",
                f"{self.base_url}/api/v1/runtimes/close",
                {"runtime_id": rid, "client_id": self.client_id},
            )
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": str(exc)}

    def input_turn(
        self,
        text: str,
        *,
        runtime_id: str | None = None,
        on_event: SseEventHandler | None = None,
        timeout_seconds: float | None = None,
        stop_when: Callable[[], bool] | None = None,
    ) -> list[dict[str, Any]]:
        """POST input and consume SSE events until done/error/cancelled or stop_when."""
        rid = (runtime_id or self.runtime_id or "").strip()
        if not rid:
            raise RuntimeError("daemon input requires runtime_id (call open first)")
        cid = self.conversation_id or rid
        body = {
            "runtime_id": rid,
            "conversation_id": cid,
            "sender_id": self.sender_id,
            "text": text,
            "client_id": self.client_id,
            "channel": None,
            "message_id": None,
            "channel_instance_id": None,
            "reply_to_message_id": None,
            "root_message_id": None,
            "mentions": [],
        }
        events: list[dict[str, Any]] = []
        for event in self.iter_sse(
            f"{self.base_url}/api/v1/runtimes/input",
            body,
            timeout_seconds=timeout_seconds,
        ):
            events.append(event)
            if on_event is not None:
                on_event(event)
            if stop_when is not None and stop_when():
                break
            et = str(event.get("type") or "")
            if et in {"done", "complete", "error", "cancelled"}:
                break
        return events

    def iter_sse(
        self,
        url: str,
        body: dict[str, Any],
        *,
        timeout_seconds: float | None = None,
    ) -> Iterator[dict[str, Any]]:
        data = json.dumps(body).encode("utf-8")
        request = Request(
            url,
            data=data,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Accept": "text/event-stream",
            },
        )
        timeout = (
            float(timeout_seconds)
            if timeout_seconds is not None
            else self.timeout_seconds
        )
        with urlopen(request, timeout=timeout) as response:
            for raw_line in response:
                line = raw_line.decode("utf-8", errors="replace").strip()
                if not line or line.startswith(":"):
                    continue
                if line.startswith("data:"):
                    line = line[5:].strip()
                if not line.startswith("{"):
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(event, dict):
                    yield event

    @staticmethod
    def http_json(method: str, url: str, body: dict[str, Any]) -> dict[str, Any]:
        data = json.dumps(body).encode("utf-8")
        request = Request(
            url,
            data=data,
            method=method,
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
        )
        try:
            with urlopen(request, timeout=60) as response:
                payload = response.read().decode("utf-8")
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"HTTP {exc.code} for {url}: {detail}") from exc
        except URLError as exc:
            raise RuntimeError(f"Failed to reach daemon {url}: {exc}") from exc
        if not payload.strip():
            return {}
        value = json.loads(payload)
        if not isinstance(value, dict):
            return {"data": value}
        return value


__all__ = ["XiaooDaemonClient"]
