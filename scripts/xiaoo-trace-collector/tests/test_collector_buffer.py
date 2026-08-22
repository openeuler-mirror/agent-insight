# coding: utf-8
"""Unit tests for Insight xiaoo-trace-collector buffer (no network)."""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import otel_trace  # noqa: E402
from otel_spans import SessionSpanBuffer  # noqa: E402


class CollectorBufferTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmpdir.cleanup)
        otel_trace.reset_buffers_for_tests()
        # Redirect buffer root via env for isolation
        import os

        os.environ["AGENT_INSIGHT_XIAOO_OTEL_BUF"] = self._tmpdir.name
        otel_trace.reset_buffers_for_tests()

    def tearDown(self) -> None:
        otel_trace.reset_buffers_for_tests()

    def test_note_and_build_spans(self) -> None:
        sid = "xiaoo:sess-collect-1"
        otel_trace.note_chat(sid, {"message": {"text": "hello user"}})
        otel_trace.note_stream(sid, "assistant reply", channel="llm_output")
        otel_trace.note_tool(
            sid,
            {
                "call": {"tool_name": "bash", "input": {"cmd": "ls"}, "call_id": "c1"},
                "outcome": {"output": "ok"},
            },
        )
        with otel_trace._LOCK:
            buf = otel_trace._BUFFERS.get("sess-collect-1")
        self.assertIsNotNone(buf)
        assert buf is not None
        self.assertTrue(buf.has_content())
        payload = buf.build_resource_spans()
        self.assertIn("resourceSpans", payload)
        spans = payload["resourceSpans"][0]["scopeSpans"][0]["spans"]
        self.assertGreaterEqual(len(spans), 2)
        scope = payload["resourceSpans"][0]["scopeSpans"][0]["scope"]["name"]
        self.assertEqual(scope, "agent-insight.xiaoo.otel")

    def test_persist_reload(self) -> None:
        sid = "xiaoo:sess-persist"
        otel_trace.note_chat(sid, {"message": {"text": "persist me"}})
        with otel_trace._LOCK:
            otel_trace._BUFFERS.clear()
        path = Path(self._tmpdir.name) / "sess-persist.json"
        self.assertTrue(path.is_file())
        # flush without post — load and check
        loaded = SessionSpanBuffer.from_dict(
            __import__("json").loads(path.read_text(encoding="utf-8"))
        )
        self.assertEqual(loaded.user_text, "persist me")

    def test_lifecycle_flush_flag(self) -> None:
        self.assertTrue(
            otel_trace.should_flush_lifecycle({"state": "idle", "outcome": "complete"})
        )
        self.assertTrue(otel_trace.should_flush_lifecycle({"state": "closed"}))

    def test_user_only_has_no_trace_spans(self) -> None:
        buf = SessionSpanBuffer("sess-user-only")
        buf.on_user_message("hello only")
        self.assertTrue(buf.has_content())
        self.assertFalse(buf.has_trace_spans())

    def test_flush_skips_user_only_without_post(self) -> None:
        sid = "xiaoo:sess-user-only-flush"
        otel_trace.note_chat(sid, {"message": {"text": "alone"}})
        posts: list[object] = []

        def _fake_post(payload):
            posts.append(payload)
            return True

        import otlp_http

        orig = otlp_http.post_otlp_traces
        otlp_http.post_otlp_traces = _fake_post  # type: ignore
        # flush_session imports post from otlp_http at call time via module attr
        import otel_trace as ot

        orig_fn = ot.post_otlp_traces
        ot.post_otlp_traces = _fake_post  # type: ignore
        try:
            ok = otel_trace.flush_session(sid)
            self.assertFalse(ok)
            self.assertEqual(posts, [])
        finally:
            ot.post_otlp_traces = orig_fn  # type: ignore
            otlp_http.post_otlp_traces = orig  # type: ignore


if __name__ == "__main__":
    unittest.main()
