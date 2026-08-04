#!/usr/bin/env python3
# coding: utf-8
"""xiaoO Plugin Hooker entry — thin Signal mapping into shared ras_embed.

Hook points:
  - ``*.Chat.message.received`` → hello
  - ``*.Tool.*.post`` → tool observe
  - ``*.Session.lifecycle.state`` → optional reset on closed-like outcomes

Also accepts ``stream_delta`` for gateway LoopEventSink fan-out.

stdin JSON → RasClient → stdout JSON. Fail-open on RAS errors.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any


def _load_stdin() -> dict[str, Any]:
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    return json.loads(raw)


def _emit(result: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    sys.stdout.flush()


def _ensure_path() -> None:
    ras_home = os.environ.get("AGENT_INSIGHT_RAS_HOME") or str(
        Path.home() / ".agent-insight" / "ras"
    )
    marker = Path(ras_home) / "install.json"
    runtime_root = None
    if marker.is_file():
        try:
            meta = json.loads(marker.read_text(encoding="utf-8"))
            runtime_root = meta.get("runtimeRoot")
        except Exception:
            runtime_root = None
    candidates = []
    if runtime_root:
        candidates.append(runtime_root)
        candidates.append(str(Path(runtime_root) / ".python-packages"))
    candidates.append(ras_home)
    for c in candidates:
        if c and c not in sys.path:
            sys.path.insert(0, c)


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


def _native_id(sid: str) -> str:
    return sid.removeprefix("xiaoo:")


def _ensure_embed() -> None:
    try:
        from ras_embed import ensure_worker

        ensure_worker()
    except Exception as exc:
        print(f"agent_ras ensure_worker: {exc}", file=sys.stderr)


def _client(session_native: str):
    from platform_adapter.xiaoo.hooks import build_xiaoo_ras_client

    return build_xiaoo_ras_client(session_id=session_native)


def _wire_actions_from_result(result: dict[str, Any] | None) -> list[dict[str, Any]]:
    """Map RAS wire actions to xiaoO HookAction-shaped dicts for stdout."""
    if not result:
        return []
    out: list[dict[str, Any]] = []
    for action in result.get("actions") or []:
        if not isinstance(action, dict):
            continue
        atype = str(action.get("type") or "")
        if atype == "abort_stream":
            out.append({"kind": "cancel_active_turn"})
        elif atype in ("emit_notice", "push_steering"):
            text = str(action.get("message") or "")
            if atype == "emit_notice" and text and not text.startswith("[RAS]"):
                text = f"[RAS] {text}"
            out.append({"kind": "send_prompt", "text": text, "session_id": ""})
    return out


def handle_chat_received(payload: dict[str, Any]) -> dict[str, Any]:
    _ensure_path()
    _ensure_embed()
    sid = _session_key(payload)
    native = _native_id(sid)
    os.environ["XIAOO_RAS_SESSION_ID"] = native
    client, _host = _client(native)
    client.ensure()
    client.hello(
        sid,
        "xiaoo",
        {
            "detection_start_chars": int(os.environ.get("RAS_DETECTION_START_CHARS", "300")),
            "window_max_chars": int(os.environ.get("RAS_WINDOW_MAX_CHARS", "1000")),
            "loop_repeat_threshold": int(os.environ.get("RAS_LOOP_REPEAT_THRESHOLD", "5")),
            "semantic_content_enabled": False,
        },
    )
    return {"type": "Acknowledged"}


def handle_session_state(payload: dict[str, Any]) -> dict[str, Any]:
    _ensure_path()
    _ensure_embed()
    sid = _session_key(payload)
    native = _native_id(sid)
    client, _host = _client(native)
    state = str(payload.get("state") or payload.get("outcome") or "").lower()
    if state in {"closed", "force_closed", "destroyed"}:
        client.reset(sid)
    return {"type": "Acknowledged"}


def handle_tool_post(payload: dict[str, Any]) -> dict[str, Any]:
    _ensure_path()
    _ensure_embed()
    from platform_adapter.xiaoo.stream_bridge import observe_tool_after

    sid = _session_key(payload)
    native = _native_id(sid)
    client, _host = _client(native)
    client.ensure()
    if not client.hello(sid, "xiaoo", {"semantic_content_enabled": False}):
        pass
    call = payload.get("call") or {}
    result = observe_tool_after(
        client,
        sid,
        name=str(call.get("tool_name") or call.get("name") or "unknown"),
        args=call.get("input") if isinstance(call.get("input"), dict) else {},
        call_id=str(call.get("call_id") or "") or None,
    )
    actions = _wire_actions_from_result(result)
    resp: dict[str, Any] = {"type": "accept"}
    if actions:
        # Fill session_id for send_prompt actions.
        for a in actions:
            if a.get("kind") == "send_prompt" and not a.get("session_id"):
                a["session_id"] = native
            if a.get("kind") == "cancel_active_turn":
                a["session_id"] = native
        resp["actions"] = actions
    return resp


def handle_stream_delta(payload: dict[str, Any]) -> dict[str, Any]:
    _ensure_path()
    _ensure_embed()
    from platform_adapter.xiaoo.stream_bridge import observe_text_delta

    sid = _session_key(payload)
    native = _native_id(sid)
    client, _host = _client(native)
    client.ensure()
    channel = str(payload.get("channel") or "llm_output")
    if channel in {"reasoning", "thinking", "llm_reasoning"}:
        channel = "llm_reasoning"
    else:
        channel = "llm_output"
    text = str(payload.get("text") or payload.get("delta") or "")
    result = observe_text_delta(
        client,
        sid,
        text,
        channel=channel,
        message_id=str(payload.get("message_id") or "") or None,
    )
    actions = _wire_actions_from_result(result)
    resp: dict[str, Any] = {"type": "accept"}
    if actions:
        for a in actions:
            if a.get("kind") == "send_prompt" and not a.get("session_id"):
                a["session_id"] = native
            if a.get("kind") == "cancel_active_turn":
                a["session_id"] = native
        resp["actions"] = actions
    return resp


HANDLERS = {
    "chat_received": handle_chat_received,
    "session_state": handle_session_state,
    "tool_post": handle_tool_post,
    "stream_delta": handle_stream_delta,
}


def main(argv: list[str]) -> int:
    op = argv[1] if len(argv) > 1 else ""
    handler = HANDLERS.get(op)
    if handler is None:
        print(f"unknown op: {op}", file=sys.stderr)
        _emit({"type": "accept"})
        return 1
    try:
        payload = _load_stdin()
        _emit(handler(payload))
        return 0
    except Exception as exc:
        print(f"agent_ras hooker error: {exc}", file=sys.stderr)
        if op in ("chat_received", "session_state"):
            _emit({"type": "Acknowledged"})
        else:
            _emit({"type": "accept"})
        return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
