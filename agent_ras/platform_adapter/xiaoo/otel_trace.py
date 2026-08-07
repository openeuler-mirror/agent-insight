# coding: utf-8
"""xiaoO session OTel buffer — disk-backed so subprocess hooks share one buffer.

Each xiaoo hooker spawn is short-lived; an in-memory-only buffer would lose
stream_delta chunks before Session.lifecycle idle flush. Persist under
``$AGENT_INSIGHT_RAS_HOME/otel-buf/<native_id>.json``.
"""
from __future__ import annotations

import json
import logging
import os
import threading
from pathlib import Path
from typing import Any

from platform_adapter.common.otel_spans import SessionSpanBuffer
from platform_adapter.common.otlp_http import post_otlp_traces
from platform_adapter.common.session_ids import strip_platform_prefix

logger = logging.getLogger(__name__)

_LOCK = threading.Lock()
_BUFFERS: dict[str, SessionSpanBuffer] = {}

_DONE_OUTCOMES = {
    "complete",
    "completed",
    "success",
    "cancelled",
    "canceled",
    "max_turns_reached",
    "budget_exhausted",
    "error",
    "failed",
    "closed",
    "force_closed",
    "destroyed",
}


def _ras_home() -> Path:
    home = (os.environ.get("AGENT_INSIGHT_RAS_HOME") or "").strip()
    if home:
        return Path(home)
    return Path.home() / ".agent-insight" / "ras"


def _buf_path(native_id: str) -> Path:
    return _ras_home() / "otel-buf" / f"{native_id}.json"


def _load_persisted(native_id: str) -> SessionSpanBuffer | None:
    path = _buf_path(native_id)
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.debug("otel buffer load failed path=%s: %s", path, exc)
        return None
    if not isinstance(data, dict):
        return None
    try:
        return SessionSpanBuffer.from_dict(data)
    except Exception as exc:
        logger.debug("otel buffer decode failed path=%s: %s", path, exc)
        return None


def _persist(buf: SessionSpanBuffer) -> None:
    path = _buf_path(buf.native_id)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(buf.to_dict(), ensure_ascii=False), encoding="utf-8")
        tmp.replace(path)
    except OSError as exc:
        logger.debug("otel buffer persist failed path=%s: %s", path, exc)


def _drop_persisted(native_id: str) -> None:
    path = _buf_path(native_id)
    try:
        if path.exists():
            path.unlink()
    except OSError:
        pass


def _buf(session_id: str) -> SessionSpanBuffer:
    native = strip_platform_prefix(session_id)
    with _LOCK:
        buf = _BUFFERS.get(native)
        if buf is None:
            buf = _load_persisted(native)
            if buf is None:
                buf = SessionSpanBuffer(native, service_name="xiaoo", agent_name="xiaoo")
            _BUFFERS[native] = buf
        return buf


def _touch(session_id: str, mutate) -> None:
    """Apply mutate(buf) and persist so the next hooker process sees it."""
    buf = _buf(session_id)
    try:
        mutate(buf)
    finally:
        _persist(buf)


def extract_message_text(payload: dict[str, Any]) -> str:
    msg = payload.get("message") or payload.get("user_message") or {}
    if isinstance(msg, str):
        return msg.strip()
    if not isinstance(msg, dict):
        return str(payload.get("text") or payload.get("content") or "").strip()
    for key in ("text", "content", "body"):
        val = msg.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    blocks = msg.get("blocks") or msg.get("parts") or []
    if isinstance(blocks, list):
        chunks: list[str] = []
        for block in blocks:
            if isinstance(block, str):
                chunks.append(block)
            elif isinstance(block, dict):
                t = block.get("text") or block.get("content")
                if t:
                    chunks.append(str(t))
        return "\n".join(chunks).strip()
    return ""


def extract_tool_output(payload: dict[str, Any]) -> Any:
    outcome = payload.get("outcome") or payload.get("result") or payload.get("tool_result")
    if outcome is None:
        return None
    if isinstance(outcome, dict):
        for key in ("output", "result", "content", "text", "value"):
            if key in outcome:
                return outcome.get(key)
        return outcome
    return outcome


def extract_tool_error(payload: dict[str, Any]) -> bool:
    outcome = payload.get("outcome") or payload.get("result")
    if isinstance(outcome, dict):
        status = str(outcome.get("status") or outcome.get("error") or "").lower()
        if status in {"error", "failed", "failure"}:
            return True
        if outcome.get("error"):
            return True
    if payload.get("error"):
        return True
    return False


def note_chat(session_id: str, payload: dict[str, Any]) -> None:
    try:
        text = extract_message_text(payload)

        def _mutate(buf: SessionSpanBuffer) -> None:
            if text:
                buf.on_user_message(text)

        _touch(session_id, _mutate)
    except Exception as exc:
        logger.debug("otel note_chat skipped: %s", exc)


def note_stream(session_id: str, text: str, *, channel: str = "llm_output") -> None:
    try:
        _touch(session_id, lambda buf: buf.on_assistant_text(text, channel=channel))
    except Exception as exc:
        logger.debug("otel note_stream skipped: %s", exc)


def note_tool(session_id: str, payload: dict[str, Any]) -> None:
    try:
        call = payload.get("call") or {}
        name = str(call.get("tool_name") or call.get("name") or "unknown")
        args = call.get("input") if isinstance(call.get("input"), dict) else call.get("arguments") or {}
        _touch(
            session_id,
            lambda buf: buf.on_tool(
                name=name,
                arguments=args if isinstance(args, dict) else {},
                output=extract_tool_output(payload),
                error=extract_tool_error(payload),
                call_id=str(call.get("call_id") or "") or None,
            ),
        )
    except Exception as exc:
        logger.debug("otel note_tool skipped: %s", exc)


def should_flush_lifecycle(payload: dict[str, Any]) -> bool:
    state = str(payload.get("state") or "").lower()
    outcome = str(payload.get("outcome") or "").lower()
    if state in {"closed", "force_closed", "destroyed"}:
        return True
    if state == "idle" and (outcome in _DONE_OUTCOMES or not outcome):
        # idle without outcome: still flush once (xiaoo often only sends idle)
        return True
    if outcome in _DONE_OUTCOMES:
        return True
    return False


def flush_session(session_id: str) -> bool:
    """Build OTLP payload and POST. Drop buffer only after successful POST."""
    native = strip_platform_prefix(session_id)
    with _LOCK:
        buf = _BUFFERS.get(native)
    if buf is None:
        buf = _load_persisted(native)
        if buf is not None:
            with _LOCK:
                _BUFFERS[native] = buf
    if buf is None or not buf.has_content():
        with _LOCK:
            _BUFFERS.pop(native, None)
        _drop_persisted(native)
        return False
    try:
        payload = buf.build_resource_spans()
        ok = post_otlp_traces(payload)
    except Exception as exc:
        logger.warning("otel flush failed: %s", exc)
        return False
    if not ok:
        return False
    with _LOCK:
        _BUFFERS.pop(native, None)
    _drop_persisted(native)
    return True


def reset_buffers_for_tests() -> None:
    with _LOCK:
        natives = list(_BUFFERS.keys())
        _BUFFERS.clear()
    for native in natives:
        _drop_persisted(native)
