# coding: utf-8
"""xiaoO session OTel buffer registry — fail-open flush to Insight."""
from __future__ import annotations

import logging
import threading
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


def _buf(session_id: str) -> SessionSpanBuffer:
    native = strip_platform_prefix(session_id)
    with _LOCK:
        buf = _BUFFERS.get(native)
        if buf is None:
            buf = SessionSpanBuffer(native, service_name="xiaoo", agent_name="xiaoo")
            _BUFFERS[native] = buf
        return buf


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
        if text:
            _buf(session_id).on_user_message(text)
        else:
            _buf(session_id)  # ensure session exists
    except Exception as exc:
        logger.debug("otel note_chat skipped: %s", exc)


def note_stream(session_id: str, text: str, *, channel: str = "llm_output") -> None:
    try:
        _buf(session_id).on_assistant_text(text, channel=channel)
    except Exception as exc:
        logger.debug("otel note_stream skipped: %s", exc)


def note_tool(session_id: str, payload: dict[str, Any]) -> None:
    try:
        call = payload.get("call") or {}
        name = str(call.get("tool_name") or call.get("name") or "unknown")
        args = call.get("input") if isinstance(call.get("input"), dict) else call.get("arguments") or {}
        _buf(session_id).on_tool(
            name=name,
            arguments=args if isinstance(args, dict) else {},
            output=extract_tool_output(payload),
            error=extract_tool_error(payload),
            call_id=str(call.get("call_id") or "") or None,
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
    """Build OTLP payload and POST. Removes buffer. Fail-open."""
    native = strip_platform_prefix(session_id)
    with _LOCK:
        buf = _BUFFERS.pop(native, None)
    if buf is None or not buf.has_content():
        return False
    try:
        payload = buf.build_resource_spans()
        return post_otlp_traces(payload)
    except Exception as exc:
        logger.warning("otel flush failed: %s", exc)
        return False


def reset_buffers_for_tests() -> None:
    with _LOCK:
        _BUFFERS.clear()
