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


def test_span_buffer_per_turn_timestamps_are_ordered() -> None:
    buf = SessionSpanBuffer("xiaoo:sess-order")
    buf.on_user_message("do work")
    buf.on_assistant_text("thinking plan A", channel="llm_reasoning")
    buf.on_tool(name="bash", arguments={"cmd": "ls"}, output="a\n", call_id="t1")
    buf.on_assistant_text("thinking plan B", channel="llm_reasoning")
    buf.on_tool(name="bash", arguments={"cmd": "pwd"}, output="/tmp\n", call_id="t2")
    payload = buf.build_resource_spans()
    spans = payload["resourceSpans"][0]["scopeSpans"][0]["spans"]
    llm_spans = [s for s in spans if s["name"].startswith("llm ")]
    tool_spans = [s for s in spans if s["name"].startswith("tool ")]
    assert len(llm_spans) == 2
    assert len(tool_spans) == 2
    timeline = sorted(
        [s for s in spans if not s["name"].startswith("agent ")],
        key=lambda s: int(s["startTimeUnixNano"]),
    )
    assert [s["name"] for s in timeline] == [
        "llm unknown",
        "tool bash",
        "llm unknown",
        "tool bash",
    ]
    assert int(llm_spans[0]["startTimeUnixNano"]) < int(tool_spans[0]["startTimeUnixNano"])
    assert int(tool_spans[0]["startTimeUnixNano"]) <= int(llm_spans[1]["startTimeUnixNano"])
    assert tool_spans[0]["parentSpanId"] == llm_spans[0]["spanId"]
    assert tool_spans[1]["parentSpanId"] == llm_spans[1]["spanId"]


def test_span_buffer_legacy_dict_migrates() -> None:
    legacy = {
        "native_id": "legacy-1",
        "service_name": "xiaoo",
        "agent_name": "xiaoo",
        "trace_id": "a" * 32,
        "root_span_id": "b" * 16,
        "started_ns": 1000,
        "user_text": "hi",
        "assistant_text": "hello",
        "reasoning_text": "",
        "tools": [{"name": "bash", "arguments": {}, "output": "ok", "error": False, "call_id": "c"}],
        "llm_span_id": "c" * 16,
        "closed": False,
    }
    buf = SessionSpanBuffer.from_dict(legacy)
    assert len(buf.turns) == 1
    payload = buf.build_resource_spans()
    spans = payload["resourceSpans"][0]["scopeSpans"][0]["spans"]
    assert any(s["name"].startswith("llm ") for s in spans)
    assert any(s["name"].startswith("tool ") for s in spans)


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

