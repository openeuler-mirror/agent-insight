#!/usr/bin/env python3
# coding: utf-8
"""Insight-owned xiaoO Trace collector hooker (⓪ only — no RAS detect/recover).

Hook points (plugin.json):
  - ``*.Chat.message.received`` → note user
  - ``*.Tool.*.post`` → note tool
  - ``*.Session.lifecycle.state`` → flush OTLP on idle/complete

xiaoO ``stream_delta`` is gateway-invoked on the RAS hooker for ① only;
this collector does **not** receive mid-stream text via RAS (no Trace forward).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

import otel_trace  # noqa: E402


def _load_stdin() -> dict[str, Any]:
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    return json.loads(raw)


def _emit(result: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    sys.stdout.flush()


def _session_key(payload: dict[str, Any]) -> str:
    sid = (
        payload.get("session_id")
        or payload.get("runtime_id")
        or (payload.get("metadata") or {}).get("session_id")
        or (payload.get("hooker") or {}).get("session_id")
        or payload.get("prompt_session")
        or "unknown"
    )
    sid = str(sid)
    return sid if sid.startswith("xiaoo:") else f"xiaoo:{sid}"


def _safe(fn, *args, **kwargs) -> None:
    try:
        fn(*args, **kwargs)
    except Exception as exc:
        print(f"xiaoo-trace-collector: {exc}", file=sys.stderr)


def handle_chat_received(payload: dict[str, Any]) -> dict[str, Any]:
    sid = _session_key(payload)
    _safe(otel_trace.note_chat, sid, payload)
    # Chat.message.received: only ``accept`` | ``transform`` (xiaoO chat adaptor).
    return {"result": "accept"}


def handle_session_state(payload: dict[str, Any]) -> dict[str, Any]:
    sid = _session_key(payload)
    do_flush = otel_trace.should_flush_lifecycle(payload)
    state = str(payload.get("state") or payload.get("outcome") or "").lower()
    if do_flush or state in {"closed", "force_closed", "destroyed", "idle"}:
        _safe(otel_trace.flush_session, sid)
    # Session.lifecycle.state is event-style: only ``ack`` is valid.
    return {"result": "ack"}


def handle_tool_post(payload: dict[str, Any]) -> dict[str, Any]:
    sid = _session_key(payload)
    _safe(otel_trace.note_tool, sid, payload)
    return {"result": "accept"}


HANDLERS = {
    "chat_received": handle_chat_received,
    "session_state": handle_session_state,
    "tool_post": handle_tool_post,
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
