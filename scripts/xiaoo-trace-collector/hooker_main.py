#!/usr/bin/env python3
# coding: utf-8
"""Insight-owned xiaoO Trace collector hooker (⓪ only — no RAS detect/recover).

Hook points (plugin.json — must be 4 dot-separated segments):
  - ``*.Chat.message.received`` → note user
  - ``*.Tool.*.post`` → note tool
  - ``*.Llm.complete.post`` → assistant completion text (Insight ⓪)
  - ``*.Session.lifecycle.state`` → flush OTLP on idle/complete

``stream_delta`` is gateway-invoked on the RAS hooker for ① only and cannot be
registered as a plugin ``hook_point``. Handler kept for tests only.
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from typing import Any

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

import otel_trace  # noqa: E402
from session_ids import strip_platform_prefix  # noqa: E402


def _load_stdin() -> dict[str, Any]:
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    return json.loads(raw)


def _emit(result: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    sys.stdout.flush()


def _insight_home() -> Path:
    data = (os.environ.get("AGENT_INSIGHT_DATA_DIR") or "").strip()
    if data:
        return Path(data)
    return Path.home() / ".agent-insight"


def _buf_root() -> Path:
    override = (os.environ.get("AGENT_INSIGHT_XIAOO_OTEL_BUF") or "").strip()
    if override:
        return Path(override)
    return _insight_home() / "xiaoo-otel-buf"


def _as_nonempty_str(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _session_candidates(payload: dict[str, Any]) -> dict[str, str]:
    """Collect possible session id fields for audit / resolution."""

    out: dict[str, str] = {}

    def take(label: str, value: Any) -> None:
        s = _as_nonempty_str(value)
        if s and label not in out:
            out[label] = s

    take("session_id", payload.get("session_id"))
    take("runtime_id", payload.get("runtime_id"))
    take("prompt_session", payload.get("prompt_session"))
    take("sessionId", payload.get("sessionId"))
    take("session", payload.get("session") if isinstance(payload.get("session"), str) else None)

    meta = payload.get("metadata")
    if isinstance(meta, dict):
        take("metadata.session_id", meta.get("session_id"))
        take("metadata.runtime_id", meta.get("runtime_id"))
        take("metadata.sessionId", meta.get("sessionId"))

    hooker = payload.get("hooker")
    if isinstance(hooker, dict):
        take("hooker.session_id", hooker.get("session_id"))
        take("hooker.runtime_id", hooker.get("runtime_id"))

    data = payload.get("data")
    if isinstance(data, dict):
        take("data.session_id", data.get("session_id"))
        take("data.runtime_id", data.get("runtime_id"))
        take("data.sessionId", data.get("sessionId"))
        info = data.get("info")
        if isinstance(info, dict):
            take("data.info.session_id", info.get("session_id"))
            take("data.info.sessionID", info.get("sessionID"))

    sess = payload.get("session")
    if isinstance(sess, dict):
        take("session.id", sess.get("id"))
        take("session.session_id", sess.get("session_id"))

    ctx = payload.get("context")
    if isinstance(ctx, dict):
        take("context.session_id", ctx.get("session_id"))
        take("context.runtime_id", ctx.get("runtime_id"))

    return out


def resolve_session_native(payload: dict[str, Any]) -> str | None:
    """Return bare platform session id, or None when unresolved (no 'unknown')."""

    candidates = _session_candidates(payload)
    # Prefer explicit session_id-shaped keys in stable priority order.
    for label in (
        "session_id",
        "sessionId",
        "runtime_id",
        "prompt_session",
        "metadata.session_id",
        "metadata.sessionId",
        "metadata.runtime_id",
        "hooker.session_id",
        "hooker.runtime_id",
        "data.session_id",
        "data.sessionId",
        "data.runtime_id",
        "data.info.session_id",
        "data.info.sessionID",
        "session.id",
        "session.session_id",
        "context.session_id",
        "context.runtime_id",
        "session",
    ):
        raw = candidates.get(label)
        if not raw:
            continue
        native = strip_platform_prefix(raw)
        if native and native.lower() != "unknown":
            return native
    return None


def _session_key(payload: dict[str, Any]) -> str | None:
    """Prefixed session key for buffers, or None when unresolved."""

    native = resolve_session_native(payload)
    if not native:
        return None
    return f"xiaoo:{native}"


_ACTIVE_SESSION_MAX_AGE_MS = 6 * 60 * 60 * 1000  # 6h


def _active_session_path() -> Path:
    return _buf_root() / "_active_session.json"


def remember_active_session(sid: str) -> None:
    """Persist last known session for hooks that omit session_id (e.g. Llm.complete.post)."""

    try:
        root = _buf_root()
        root.mkdir(parents=True, exist_ok=True)
        row = {"sid": sid, "ts_ms": int(time.time() * 1000)}
        _active_session_path().write_text(json.dumps(row), encoding="utf-8")
    except OSError as exc:
        print(f"xiaoo-trace-collector: remember session failed: {exc}", file=sys.stderr)


def recall_active_session(*, max_age_ms: int = _ACTIVE_SESSION_MAX_AGE_MS) -> str | None:
    """Return sticky ``xiaoo:<uuid>`` if recent; else None."""

    path = _active_session_path()
    try:
        if not path.is_file():
            return None
        row = json.loads(path.read_text(encoding="utf-8"))
        sid = _as_nonempty_str(row.get("sid") if isinstance(row, dict) else None)
        if not sid or not sid.startswith("xiaoo:"):
            return None
        native = strip_platform_prefix(sid)
        if not native or native.lower() == "unknown":
            return None
        ts_ms = int(row.get("ts_ms") or 0) if isinstance(row, dict) else 0
        if ts_ms and (int(time.time() * 1000) - ts_ms) > max_age_ms:
            return None
        return f"xiaoo:{native}"
    except (OSError, TypeError, ValueError, json.JSONDecodeError):
        return None


def resolve_session_key(payload: dict[str, Any], *, allow_sticky: bool = False) -> str | None:
    """Resolve prefixed session key; optionally fall back to sticky last chat/lifecycle."""

    sid = _session_key(payload)
    if sid is not None:
        remember_active_session(sid)
        return sid
    if allow_sticky:
        return recall_active_session()
    return None


def _audit_enabled() -> bool:
    flag = (os.environ.get("AGENT_INSIGHT_XIAOO_HOOK_AUDIT") or "").strip().lower()
    return flag in {"1", "true", "yes", "on"}


def _audit_hook(op: str, payload: dict[str, Any], *, sid: str | None) -> None:
    if not _audit_enabled():
        return
    try:
        root = _buf_root()
        root.mkdir(parents=True, exist_ok=True)
        row = {
            "ts_ms": int(time.time() * 1000),
            "op": op,
            "top_keys": sorted(payload.keys()) if isinstance(payload, dict) else [],
            "session_candidates": _session_candidates(payload),
            "resolved_sid": sid,
            "state": payload.get("state") if isinstance(payload, dict) else None,
            "outcome": payload.get("outcome") if isinstance(payload, dict) else None,
            "channel": payload.get("channel") if isinstance(payload, dict) else None,
        }
        if sid is None and isinstance(payload, dict):
            # Compact nested shape when session unresolved (audit only).
            nested: dict[str, Any] = {}
            for key, value in payload.items():
                if isinstance(value, dict):
                    nested[key] = sorted(value.keys())
                elif isinstance(value, list):
                    nested[key] = f"list:{len(value)}"
                else:
                    nested[key] = type(value).__name__
            row["value_shapes"] = nested
        with (root / "_hook-audit.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(row, ensure_ascii=False) + "\n")
    except OSError as exc:
        print(f"xiaoo-trace-collector: audit failed: {exc}", file=sys.stderr)


def _safe(fn, *args, **kwargs) -> None:
    try:
        fn(*args, **kwargs)
    except Exception as exc:
        print(f"xiaoo-trace-collector: {exc}", file=sys.stderr)


def handle_chat_received(payload: dict[str, Any]) -> dict[str, Any]:
    sid = resolve_session_key(payload, allow_sticky=False)
    _audit_hook("chat_received", payload, sid=sid)
    if sid is None:
        print(
            "xiaoo-trace-collector: skip chat_received — unresolved session_id "
            f"keys={sorted(payload.keys())}",
            file=sys.stderr,
        )
        return {"result": "accept"}
    _safe(otel_trace.note_chat, sid, payload)
    return {"result": "accept"}


def handle_session_state(payload: dict[str, Any]) -> dict[str, Any]:
    sid = resolve_session_key(payload, allow_sticky=False)
    _audit_hook("session_state", payload, sid=sid)
    if sid is None:
        print(
            "xiaoo-trace-collector: skip session_state flush — unresolved session_id "
            f"keys={sorted(payload.keys())}",
            file=sys.stderr,
        )
        return {"result": "ack"}
    do_flush = otel_trace.should_flush_lifecycle(payload)
    state = str(payload.get("state") or payload.get("outcome") or "").lower()
    if do_flush or state in {"closed", "force_closed", "destroyed", "idle"}:
        _safe(otel_trace.flush_session, sid)
    return {"result": "ack"}


def handle_tool_post(payload: dict[str, Any]) -> dict[str, Any]:
    # Tool payloads may omit session_id; sticky from prior chat/lifecycle.
    sid = resolve_session_key(payload, allow_sticky=True)
    _audit_hook("tool_post", payload, sid=sid)
    if sid is None:
        print(
            "xiaoo-trace-collector: skip tool_post — unresolved session_id "
            f"keys={sorted(payload.keys())}",
            file=sys.stderr,
        )
        return {"result": "accept"}
    _safe(otel_trace.note_tool, sid, payload)
    return {"result": "accept"}


def extract_llm_completion_text(payload: dict[str, Any]) -> str:
    """Best-effort assistant text from ``*.Llm.complete.post`` payload."""

    response = payload.get("response")
    if isinstance(response, dict):
        message = response.get("message")
        if isinstance(message, dict):
            text = message.get("text") or message.get("content")
            if isinstance(text, str) and text.strip():
                return text.strip()
        text = response.get("text") or response.get("content")
        if isinstance(text, str) and text.strip():
            return text.strip()
    message = payload.get("message")
    if isinstance(message, dict):
        text = message.get("text") or message.get("content")
        if isinstance(text, str) and text.strip():
            return text.strip()
    text = payload.get("text") or payload.get("content")
    if isinstance(text, str) and text.strip():
        return text.strip()
    return ""


def handle_llm_complete_post(payload: dict[str, Any]) -> dict[str, Any]:
    """Insight ⓪ assistant completion via ``*.Llm.complete.post``.

    xiaoO's Llm.complete.post payload has ``response.message.text`` but no
    ``session_id``; associate via sticky session remembered from chat/lifecycle.
    """

    sid = resolve_session_key(payload, allow_sticky=True)
    _audit_hook("llm_complete_post", payload, sid=sid)
    if sid is None:
        print(
            "xiaoo-trace-collector: skip llm_complete_post — unresolved session_id "
            f"keys={sorted(payload.keys())}",
            file=sys.stderr,
        )
        return {"result": "accept"}
    text = extract_llm_completion_text(payload)
    if text:
        _safe(otel_trace.note_stream, sid, text, channel="llm_output")
    return {"result": "accept"}


def handle_stream_delta(payload: dict[str, Any]) -> dict[str, Any]:
    """Tests / future dual-invoke only — not registered in plugin.json."""

    sid = resolve_session_key(payload, allow_sticky=True)
    _audit_hook("stream_delta", payload, sid=sid)
    if sid is None:
        print(
            "xiaoo-trace-collector: skip stream_delta — unresolved session_id "
            f"keys={sorted(payload.keys())}",
            file=sys.stderr,
        )
        return {"result": "accept"}
    channel = str(payload.get("channel") or "llm_output")
    if channel in {"reasoning", "thinking", "llm_reasoning"}:
        channel = "llm_reasoning"
    else:
        channel = "llm_output"
    text = str(payload.get("text") or payload.get("delta") or "")
    if text:
        _safe(otel_trace.note_stream, sid, text, channel=channel)
    return {"result": "accept"}


HANDLERS = {
    "chat_received": handle_chat_received,
    "session_state": handle_session_state,
    "tool_post": handle_tool_post,
    "llm_complete_post": handle_llm_complete_post,
    "stream_delta": handle_stream_delta,
}


def main(argv: list[str]) -> int:
    op = argv[1] if len(argv) > 1 else ""
    handler = HANDLERS.get(op)
    if handler is None:
        print(f"xiaoo-trace-collector unknown op: {op}", file=sys.stderr)
        _emit({"result": "accept"})
        return 1
    try:
        payload = _load_stdin()
        _emit(handler(payload))
        return 0
    except Exception as exc:
        print(f"xiaoo-trace-collector error: {exc}", file=sys.stderr)
        if op == "session_state":
            _emit({"result": "ack"})
        else:
            _emit({"result": "accept"})
        return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
