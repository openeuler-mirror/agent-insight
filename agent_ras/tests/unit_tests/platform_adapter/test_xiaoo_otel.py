# coding: utf-8
from __future__ import annotations

from platform_adapter.common.otel_spans import SessionSpanBuffer
from platform_adapter.common.session_ids import strip_platform_prefix, with_platform_prefix
from platform_adapter.xiaoo import otel_trace


def test_strip_platform_prefix() -> None:
    assert strip_platform_prefix("xiaoo:abc") == "abc"
    assert strip_platform_prefix("ses_1") == "ses_1"
    assert with_platform_prefix("xiaoo", "abc") == "xiaoo:abc"
    assert with_platform_prefix("xiaoo", "xiaoo:abc") == "xiaoo:abc"


def test_span_buffer_builds_session_id_and_kinds() -> None:
    buf = SessionSpanBuffer("xiaoo:sess-otel-1")
    buf.on_user_message("hello user")
    buf.on_assistant_text("hello assistant", channel="llm_output")
    buf.on_tool(name="bash", arguments={"cmd": "echo hi"}, output="hi\n", error=False, call_id="c1")
    payload = buf.build_resource_spans()
    resource = payload["resourceSpans"][0]["resource"]["attributes"]
    keys = {item["key"]: item["value"] for item in resource}
    assert keys["service.name"]["stringValue"] == "xiaoo"
    assert keys["session.id"]["stringValue"] == "sess-otel-1"
    assert keys["witty.session.id"]["stringValue"] == "sess-otel-1"

    spans = payload["resourceSpans"][0]["scopeSpans"][0]["spans"]
    assert len(spans) >= 3
    names = [s["name"] for s in spans]
    assert any(n.startswith("agent ") for n in names)
    assert any(n.startswith("llm ") for n in names)
    assert any(n.startswith("tool ") for n in names)

    tool = next(s for s in spans if s["name"].startswith("tool "))
    tattrs = {a["key"]: a["value"] for a in tool["attributes"]}
    assert tattrs["tool.name"]["stringValue"] == "bash"
    assert "session.id" in tattrs
    assert "gen_ai.span.kind" in tattrs


def test_otel_trace_lifecycle_and_flush(monkeypatch) -> None:
    otel_trace.reset_buffers_for_tests()
    posted: list[dict] = []

    def fake_post(payload, timeout=8.0):
        del timeout
        posted.append(payload)
        return True

    monkeypatch.setattr("platform_adapter.xiaoo.otel_trace.post_otlp_traces", fake_post)

    sid = "xiaoo:e2e_otel_unit"
    otel_trace.note_chat(sid, {"message": {"text": "ping"}})
    otel_trace.note_stream(sid, "pong", channel="llm_output")
    otel_trace.note_tool(
        sid,
        {
            "call": {"tool_name": "bash", "input": {"cmd": "x"}, "call_id": "1"},
            "outcome": {"output": "ok"},
        },
    )
    assert otel_trace.should_flush_lifecycle({"state": "idle", "outcome": "complete"})
    assert otel_trace.flush_session(sid) is True
    assert len(posted) == 1
    # second flush is no-op
    assert otel_trace.flush_session(sid) is False


def test_otel_buffer_survives_memory_clear(monkeypatch, tmp_path) -> None:
    """Simulate short-lived hooker processes: notes persist on disk across reset."""
    monkeypatch.setenv("AGENT_INSIGHT_RAS_HOME", str(tmp_path))
    otel_trace.reset_buffers_for_tests()
    posted: list[dict] = []
    monkeypatch.setattr(
        "platform_adapter.xiaoo.otel_trace.post_otlp_traces",
        lambda payload, timeout=8.0: posted.append(payload) or True,
    )

    sid = "xiaoo:persist-1"
    otel_trace.note_chat(sid, {"message": {"text": "user asks"}})
    otel_trace.note_stream(sid, "assistant reply", channel="llm_output")
    # Drop in-process cache (as if the hooker process exited).
    with otel_trace._LOCK:
        otel_trace._BUFFERS.clear()

    assert otel_trace.flush_session(sid) is True
    assert len(posted) == 1
    spans = posted[0]["resourceSpans"][0]["scopeSpans"][0]["spans"]
    assert any(s["name"].startswith("llm ") for s in spans)

