# coding: utf-8
"""Unit tests for xiaoo Daemon SSE mapping + HostControl."""
from __future__ import annotations

import json
from typing import Any

from platform_adapter.xiaoo.daemon_client import XiaooDaemonClient
from platform_adapter.xiaoo.daemon_session import map_sse_event_to_observes
from platform_adapter.xiaoo.hooks import build_xiaoo_daemon_host_fns, build_xiaoo_ras_client
from ras_runtime import reset_runtime_for_tests


def test_build_xiaoo_daemon_host_fns() -> None:
    seen: list[tuple[str, str | None]] = []

    def cancel_fn() -> dict[str, Any]:
        seen.append(("cancel", None))
        return {"ok": True}

    def input_fn(message: str) -> dict[str, Any]:
        seen.append(("input", message))
        return {"ok": True}

    abort, notice, steer = build_xiaoo_daemon_host_fns(
        cancel_fn=cancel_fn, input_fn=input_fn
    )
    assert abort()["ok"] is True
    assert steer("go")["ok"] is True
    assert notice("hi")["ok"] is True
    assert seen[0] == ("cancel", None)
    assert seen[1] == ("input", "go")
    assert seen[2][0] == "input" and "[RAS]" in (seen[2][1] or "")


def test_map_sse_text_and_thinking(monkeypatch) -> None:
    reset_runtime_for_tests()
    aborts: list[str] = []
    client, _host = build_xiaoo_ras_client(
        abort_fn=lambda: aborts.append("a") or {"ok": True},
        notice_fn=lambda m: None,
        steer_fn=lambda m: None,
    )
    sid = "xiaoo:map-sse-1"
    assert client.ensure()
    client.hello(
        sid,
        "xiaoo",
        {
            "detection_start_chars": 1,
            "window_max_chars": 200,
            "loop_repeat_threshold": 3,
            "semantic_content_enabled": False,
        },
    )
    mids: dict[str, str] = {}
    chunk = ("计划下一步。确认目标。准备执行。" * 4) + "\n"
    snap = ""
    for _ in range(24):
        snap += chunk
        map_sse_event_to_observes(
            {"type": "thinking_delta", "delta": chunk, "snapshot": snap},
            session_id=sid,
            client=client,
            message_ids=mids,
        )
    assert aborts, "thinking loop should trigger abort via Host"


def test_map_sse_tool_result_unknown_repeat() -> None:
    reset_runtime_for_tests()
    aborts: list[str] = []
    client, _host = build_xiaoo_ras_client(
        abort_fn=lambda: aborts.append("a") or {"ok": True},
        notice_fn=lambda m: None,
        steer_fn=lambda m: None,
    )
    sid = "xiaoo:map-tool-1"
    assert client.ensure()
    client.hello(
        sid,
        "xiaoo",
        {
            "detection_start_chars": 1,
            "window_max_chars": 200,
            "loop_repeat_threshold": 3,
            "semantic_content_enabled": False,
        },
    )
    mids: dict[str, str] = {}
    for i in range(12):
        map_sse_event_to_observes(
            {
                "type": "tool_result",
                "tool_name": "bash",
                "call_id": f"c{i}",
                "output_preview": "command not found",
                "is_error": True,
                "args_preview": json.dumps({"command": "nonexistent_command_abc123"}),
            },
            session_id=sid,
            client=client,
            message_ids=mids,
        )
    assert aborts, "unknown_tool_repeat should abort"


def test_daemon_client_cancel_posts(monkeypatch) -> None:
    calls: list[tuple[str, str, dict]] = []

    def fake_http(method: str, url: str, body: dict[str, Any]) -> dict[str, Any]:
        calls.append((method, url, body))
        return {"type": "cancelled", "runtime_id": body.get("runtime_id")}

    monkeypatch.setattr(XiaooDaemonClient, "http_json", staticmethod(fake_http))
    client = XiaooDaemonClient("http://127.0.0.1:18080", client_id="ras-test")
    client.runtime_id = "rt-1"
    out = client.cancel()
    assert out["ok"] is True
    assert calls[0][0] == "POST"
    assert calls[0][1].endswith("/api/v1/runtimes/cancel")
    assert calls[0][2]["client_id"] == "ras-test"
    assert calls[0][2]["runtime_id"] == "rt-1"


def test_hooker_tool_post_skips_hello(monkeypatch) -> None:
    from platform_adapter.xiaoo.hooker import hooker_main as hm

    hellos: list[str] = []

    class FakeClient:
        def ensure(self):
            return True

        def hello(self, *args, **kwargs):
            hellos.append("hello")
            return {"type": "welcome"}

        def observe(self, session_id, payload):
            return {"session_id": session_id, "actions": [], "anomaly": None}

    monkeypatch.setattr(hm, "_ensure_path", lambda: None)
    monkeypatch.setattr(hm, "_sync_capability_config", lambda: None)
    monkeypatch.setattr(hm, "_ensure_embed", lambda: None)
    monkeypatch.setattr(hm, "_otel_safe", lambda *a, **k: None)
    monkeypatch.setattr(hm, "_client", lambda native: (FakeClient(), None))

    resp = hm.handle_tool_post(
        {
            "session_id": "s1",
            "call": {
                "tool_name": "bash",
                "call_id": "c1",
                "input": {"command": "true"},
                "is_error": True,
                "output": "fail",
            },
        }
    )
    assert resp["type"] == "accept"
    assert hellos == [], "tool_post must not call hello"
