# coding: utf-8
from __future__ import annotations

import json
import os
from pathlib import Path

from platform_adapter.common.observe import observe_assistant_text, observe_tool_after
from platform_adapter.xiaoo.hooks import build_xiaoo_host_fns, build_xiaoo_ras_client
from platform_adapter.xiaoo.stream_bridge import (
    observe_text_delta,
    observe_tool_after as xiaoo_observe_tool,
)
from ras_embed import ensure_worker, ipc_available, reset_runtime_for_tests
from ras_embed.ipc import call_ipc, default_sock_path


def test_build_xiaoo_ras_client_unwired() -> None:
    client, host = build_xiaoo_ras_client()
    assert client.on_actions is not None
    assert host.request_abort_stream()["ok"] is False
    assert host.platform == "xiaoo"


def test_build_xiaoo_host_fns_publish(monkeypatch) -> None:
    seen: list[tuple[str, str, str | None]] = []

    def fake_publish(op, session_id, message=None, sock_path=None):
        del sock_path
        seen.append((op, session_id, message))
        return True

    monkeypatch.setattr(
        "platform_adapter.xiaoo.hooks.publish_host_control",
        fake_publish,
    )
    abort, notice, steer = build_xiaoo_host_fns(session_id="sess-1")
    abort()
    steer("go")
    notice("hi")
    assert seen[0] == ("abort", "sess-1", None)
    assert seen[1][0] == "steer" and seen[1][2] == "go"
    assert seen[2][0] == "steer" and "[RAS]" in (seen[2][2] or "")


def test_observe_helpers_call_client() -> None:
    class FakeClient:
        def __init__(self) -> None:
            self.payloads: list[dict] = []

        def observe(self, session_id, payload):
            self.payloads.append({"sid": session_id, **payload})
            return {"ok": True}

    client = FakeClient()
    observe_assistant_text(
        client, "xiaoo:s1", "abc", platform="xiaoo", channel="llm_reasoning"
    )
    observe_tool_after(
        client, "xiaoo:s1", platform="xiaoo", name="bash", args={"cmd": "ls"}
    )
    observe_text_delta(client, "xiaoo:s1", "xyz", channel="llm_output")
    xiaoo_observe_tool(client, "xiaoo:s1", name="bash", args={})
    assert client.payloads[0]["channel"] == "llm_reasoning"
    assert client.payloads[1]["kind"] == "tool"
    assert client.payloads[2]["platform"] == "xiaoo"


def test_ipc_worker_shares_session(tmp_path: Path, monkeypatch) -> None:
    reset_runtime_for_tests()
    sock = tmp_path / "ras_embed.sock"
    monkeypatch.setenv("RAS_EMBED_SOCK", str(sock))
    monkeypatch.setenv("AGENT_INSIGHT_RAS_HOME", str(tmp_path))
    monkeypatch.delenv("RAS_EMBED_IPC_FORCE_LOCAL", raising=False)
    path = ensure_worker(sock_path=sock, wait_s=8.0)
    assert path.exists()
    assert ipc_available(path)
    hello = call_ipc(
        "hello",
        "xiaoo:ipc1",
        {"platform": "xiaoo", "config": {"semantic_content_enabled": False}},
        sock_path=path,
    )
    assert hello.get("type") == "welcome" or hello.get("session_id") == "xiaoo:ipc1"
    health = call_ipc("health", "", {}, sock_path=path)
    assert health.get("status") == "ok"
    assert int(health.get("session_count") or 0) >= 1
