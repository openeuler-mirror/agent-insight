#!/usr/bin/env python3
# coding: utf-8
"""xiaoO Plugin Hooker entry — thin Signal mapping into shared ras_runtime.

Hook points:
  - ``*.Chat.message.received`` → hello
  - ``*.Tool.*.post`` → tool observe (**no hello** — preserves detector buffers)
  - ``*.Session.lifecycle.state`` → reset on idle/complete
  - ``stream_delta`` → text observe only (① detect/recover; **no** Trace forward)

stdin JSON → RasClient → stdout JSON. Fail-open on RAS errors.

Complete-link Trace (⓪) is owned solely by Insight ``xiaoo-trace-collector``.
This hooker must not buffer/flush OTLP or call Insight ``note_*``.

For stock-master mid-stream thinking + abort, prefer Daemon SSE
(``DaemonRasSession``); plugin hooks alone lack cancel on CLI.
"""
from __future__ import annotations

import json
import os
import sys
import time
import uuid
from pathlib import Path
from typing import Any

# Turn-stable LLM message ids when host omits them (cleared on tool_post).
_LLM_TURN_MSG: dict[str, str] = {}
# FI event dedupe: message_id already written this process.
_FI_LLM_TURN_WRITTEN: set[str] = set()


def _load_stdin() -> dict[str, Any]:
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    return json.loads(raw)


def _emit(result: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    sys.stdout.flush()


def _append_fi_llm_turn_event(*, message_id: str, channel: str, session_id: str) -> None:
    """Mirror LLM identity into FI events so interactions can carry messageID (OC parity)."""
    if not message_id or message_id in _FI_LLM_TURN_WRITTEN:
        return
    run_id = (os.environ.get("AGENT_FI_RUN_ID") or "").strip()
    raw_dir = (os.environ.get("AGENT_FI_RAW_DIR") or "").strip()
    if not run_id or not raw_dir:
        return
    events_file = Path(raw_dir) / "events.jsonl"
    try:
        events_file.parent.mkdir(parents=True, exist_ok=True)
        sequence = 1
        if events_file.is_file():
            with events_file.open("r", encoding="utf-8") as stream:
                for line in stream:
                    if line.strip():
                        sequence += 1
        row = {
            "schema_version": "1",
            "run_id": run_id,
            "sequence": sequence,
            "recorded_at": int(time.time() * 1000),
            "source": "xiaoo-ras-hooker",
            "kind": "xiaoo.event",
            "payload": {
                "type": "llm.turn",
                "message_id": message_id,
                "channel": channel,
                "session_id": session_id,
            },
        }
        with events_file.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(row, ensure_ascii=False) + "\n")
        _FI_LLM_TURN_WRITTEN.add(message_id)
    except OSError:
        pass


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


def _session_key(payload: dict[str, Any]) -> str | None:
    meta = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
    hooker = payload.get("hooker") if isinstance(payload.get("hooker"), dict) else {}
    raw = (
        payload.get("session_id")
        or payload.get("runtime_id")
        or meta.get("session_id")
        or hooker.get("session_id")
        or payload.get("prompt_session")
    )
    if raw is None:
        return None
    sid = str(raw).strip()
    if not sid:
        return None
    native = sid.removeprefix("xiaoo:")
    if not native or native.lower() == "unknown":
        return None
    return sid if sid.startswith("xiaoo:") else f"xiaoo:{sid}"


def _require_session(payload: dict[str, Any], *, op: str) -> str | None:
    sid = _session_key(payload)
    if sid is None:
        print(
            f"agent_ras hooker {op}: missing session id; skip observe",
            file=sys.stderr,
        )
        return None
    return sid


def _native_id(sid: str) -> str:
    return sid.removeprefix("xiaoo:")


def _ensure_embed() -> None:
    try:
        from platform_adapter.common.transport.subprocess_ipc import ensure_worker

        ensure_worker()
    except Exception as exc:
        print(f"agent_ras ensure_worker: {exc}", file=sys.stderr)


def _sync_capability_config() -> None:
    """Best-effort Insight → local config.json sync (TTL-gated)."""
    try:
        from platform_adapter.xiaoo.config_sync import sync_capability_config_from_insight

        result = sync_capability_config_from_insight(
            platform="xiaoo",
            log=lambda msg: print(msg, file=sys.stderr),
        )
        if result.get("applied"):
            print(
                f"agent_ras sync: applied revision={result.get('revision')}",
                file=sys.stderr,
            )
    except Exception as exc:
        print(f"agent_ras sync: {exc}", file=sys.stderr)


def _hello_config() -> dict[str, Any]:
    try:
        from platform_adapter.xiaoo.config_sync import load_hello_config_from_ras_config

        return load_hello_config_from_ras_config()
    except Exception as exc:
        print(f"agent_ras hello_config: {exc}", file=sys.stderr)
        return {
            "detectors": {},
        }


def _client(_session_native: str):
    from platform_adapter.xiaoo.hooks import build_xiaoo_ras_client

    return build_xiaoo_ras_client()


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
    sid = _require_session(payload, op="chat_received")
    if sid is None:
        return {"result": "accept"}
    _sync_capability_config()
    _ensure_embed()
    native = _native_id(sid)
    os.environ["XIAOO_RAS_SESSION_ID"] = native
    client, _host = _client(native)
    client.ensure()
    client.hello(sid, "xiaoo", _hello_config())
    # Chat.message.received: only ``accept`` | ``transform`` (xiaoO chat adaptor).
    return {"result": "accept"}


def handle_session_state(payload: dict[str, Any]) -> dict[str, Any]:
    _ensure_path()
    sid = _require_session(payload, op="session_state")
    if sid is None:
        return {"result": "ack"}
    _ensure_embed()
    native = _native_id(sid)
    client, _host = _client(native)
    state = str(payload.get("state") or payload.get("outcome") or "").lower()
    if state in {"closed", "force_closed", "destroyed", "idle"}:
        client.reset(sid)
    # Session.lifecycle.state is event-style: only ``ack`` is valid.
    return {"result": "ack"}


def handle_tool_post(payload: dict[str, Any]) -> dict[str, Any]:
    _ensure_path()
    sid = _require_session(payload, op="tool_post")
    if sid is None:
        return {"result": "accept"}
    _sync_capability_config()
    _ensure_embed()
    from platform_adapter.xiaoo.stream_bridge import observe_tool_after

    native = _native_id(sid)
    client, _host = _client(native)
    client.ensure()
    # Do NOT hello here — hello rebuilds SessionState and wipes detector buffers.
    call = payload.get("call") or {}
    _LLM_TURN_MSG.pop(sid, None)
    _LLM_TURN_MSG.pop(native, None)
    output = call.get("output")
    is_error = bool(
        call.get("is_error")
        or call.get("error")
        or str(call.get("status") or "").lower() in {"error", "failed", "denied"}
    )
    err_text = None
    if call.get("error"):
        err_text = str(call.get("error"))
    elif is_error and isinstance(output, str):
        err_text = output
    tool_result = None
    if isinstance(output, dict):
        tool_result = output
    elif output is not None:
        tool_result = {
            "output": str(output),
            "success": not is_error,
            **({"error": err_text or str(output), "status": "error"} if is_error else {}),
        }
    result = observe_tool_after(
        client,
        sid,
        name=str(call.get("tool_name") or call.get("name") or "unknown"),
        args=call.get("input") if isinstance(call.get("input"), dict) else {},
        call_id=str(call.get("call_id") or "") or None,
        result=tool_result,
        error=err_text,
        is_error=is_error,
    )
    actions = _wire_actions_from_result(result)
    resp: dict[str, Any] = {"result": "accept"}
    if actions:
        for a in actions:
            if a.get("kind") == "send_prompt" and not a.get("session_id"):
                a["session_id"] = native
            if a.get("kind") == "cancel_active_turn":
                a["session_id"] = native
        resp["actions"] = actions
    return resp


def handle_stream_delta(payload: dict[str, Any]) -> dict[str, Any]:
    _ensure_path()
    sid = _require_session(payload, op="stream_delta")
    if sid is None:
        return {"result": "accept"}
    _ensure_embed()
    from platform_adapter.xiaoo.stream_bridge import observe_text_delta

    native = _native_id(sid)
    client, _host = _client(native)
    client.ensure()
    channel = str(payload.get("channel") or "llm_output")
    if channel in {"reasoning", "thinking", "llm_reasoning"}:
        channel = "llm_reasoning"
    else:
        channel = "llm_output"
    text = str(payload.get("text") or payload.get("delta") or "")
    mid = str(payload.get("message_id") or "").strip()
    if mid:
        _LLM_TURN_MSG[sid] = mid
    else:
        mid = _LLM_TURN_MSG.get(sid) or f"xiaoo-llm-{uuid.uuid4().hex[:16]}"
        _LLM_TURN_MSG[sid] = mid
    _append_fi_llm_turn_event(message_id=mid, channel=channel, session_id=native)
    result = observe_text_delta(
        client,
        sid,
        text,
        channel=channel,
        message_id=mid,
    )
    actions = _wire_actions_from_result(result)
    resp: dict[str, Any] = {"result": "accept"}
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
        _emit({"result": "accept"})
        return 1
    try:
        payload = _load_stdin()
        _emit(handler(payload))
        return 0
    except Exception as exc:
        print(f"agent_ras hooker error: {exc}", file=sys.stderr)
        if op == "session_state":
            _emit({"result": "ack"})
        else:
            _emit({"result": "accept"})
        return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
