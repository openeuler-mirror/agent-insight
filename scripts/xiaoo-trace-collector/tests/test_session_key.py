# coding: utf-8
"""Unit tests for collector session resolution (no network)."""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

# Load hooker_main as module (not __main__).
_spec = importlib.util.spec_from_file_location(
    "xiaoo_collector_hooker_main",
    ROOT / "hooker_main.py",
)
assert _spec and _spec.loader
hooker_main = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hooker_main)


class SessionKeyTests(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        env = patch.dict(os.environ, {"AGENT_INSIGHT_XIAOO_OTEL_BUF": tmp.name})
        env.start()
        self.addCleanup(env.stop)
        scope = patch.object(hooker_main, "_process_scope", return_value="process-a")
        self.scope = scope.start()
        self.addCleanup(scope.stop)

    def test_top_level_session_id(self) -> None:
        sid = hooker_main._session_key({"session_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"})
        self.assertEqual(sid, "xiaoo:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")

    def test_nested_data_session_id(self) -> None:
        sid = hooker_main._session_key(
            {"data": {"session_id": "11111111-2222-3333-4444-555555555555"}}
        )
        self.assertEqual(sid, "xiaoo:11111111-2222-3333-4444-555555555555")

    def test_strips_existing_prefix(self) -> None:
        sid = hooker_main._session_key({"session_id": "xiaoo:abc-def"})
        self.assertEqual(sid, "xiaoo:abc-def")

    def test_unresolved_returns_none_not_unknown(self) -> None:
        self.assertIsNone(hooker_main._session_key({"foo": "bar"}))
        self.assertIsNone(hooker_main.resolve_session_native({}))

    def test_rejects_literal_unknown(self) -> None:
        self.assertIsNone(hooker_main.resolve_session_native({"session_id": "unknown"}))

    def test_extract_llm_completion_text(self) -> None:
        text = hooker_main.extract_llm_completion_text(
            {"response": {"message": {"text": "hello from llm"}}}
        )
        self.assertEqual(text, "hello from llm")

    def test_sticky_session_for_llm_complete(self) -> None:
        remembered = hooker_main.resolve_session_key({"session_id": "session-a"})
        self.assertEqual(remembered, "xiaoo:session-a")
        self.assertEqual(hooker_main.resolve_session_key({}, allow_sticky=True), remembered)
        self.assertIsNone(hooker_main.resolve_session_key({}, allow_sticky=False))

    def test_experiment_and_tui_do_not_share_session(self) -> None:
        hooker_main.resolve_session_key({"session_id": "experiment"})
        self.scope.return_value = "process-b"
        self.assertIsNone(hooker_main.resolve_session_key({}, allow_sticky=True))
        hooker_main.resolve_session_key({"session_id": "tui"})
        with patch.object(hooker_main.otel_trace, "note_tool") as tool:
            hooker_main.handle_tool_post({"call": {"tool_name": "bash"}})
            self.assertEqual(tool.call_args.args[0], "xiaoo:tui")
            self.scope.return_value = "process-a"
            hooker_main.handle_tool_post({"call": {"tool_name": "bash"}})
            self.assertEqual(tool.call_args.args[0], "xiaoo:experiment")
        with patch.object(hooker_main.otel_trace, "note_stream") as stream:
            hooker_main.handle_llm_complete_post({"response": {"text": "patch done"}})
            self.assertEqual(stream.call_args.args[0], "xiaoo:experiment")

    def test_ambiguous_same_process_is_not_guessed(self) -> None:
        hooker_main.resolve_session_key({"session_id": "a"})
        hooker_main.resolve_session_key({"session_id": "b"})
        self.assertIsNone(hooker_main.resolve_session_key({}, allow_sticky=True))
        self.assertEqual(hooker_main.resolve_session_key({"session_id": "a"}), "xiaoo:a")
        with patch.object(hooker_main.otel_trace, "note_tool") as tool:
            hooker_main.handle_tool_post({})
            tool.assert_not_called()

    def test_terminal_session_released_even_when_upload_fails(self) -> None:
        hooker_main.resolve_session_key({"session_id": "a"})
        hooker_main.resolve_session_key({"session_id": "b"})
        with patch.object(hooker_main.otel_trace, "flush_session", side_effect=OSError("offline")):
            hooker_main.handle_session_state({"session_id": "a", "state": "idle"})
        self.assertEqual(hooker_main.resolve_session_key({}, allow_sticky=True), "xiaoo:b")

    def test_old_global_file_ignored(self) -> None:
        (self.root / "_active_session.json").write_text(json.dumps({"sid": "xiaoo:old"}))
        self.assertIsNone(hooker_main.resolve_session_key({}, allow_sticky=True))

    def test_unknown_process_does_not_use_sticky(self) -> None:
        self.scope.return_value = None
        self.assertEqual(hooker_main.resolve_session_key({"session_id": "a"}), "xiaoo:a")
        self.assertIsNone(hooker_main.resolve_session_key({}, allow_sticky=True))

    def test_stale_or_corrupt_state_is_not_guessed(self) -> None:
        hooker_main.resolve_session_key({"session_id": "a"})
        self.assertIsNone(hooker_main.recall_active_session(max_age_ms=-1))
        (hooker_main._active_session_dir() / "corrupt.json").write_text("[]")
        self.assertIsNone(hooker_main.recall_active_session())


class ProcessScopeTests(unittest.TestCase):
    def setUp(self) -> None:
        hooker_main._process_scope.cache_clear()
        self.addCleanup(hooker_main._process_scope.cache_clear)

    def test_scope_includes_process_start_time(self) -> None:
        with patch.object(hooker_main.os, "getppid", return_value=123), patch.object(
            hooker_main.subprocess, "check_output", return_value="Wed Sep 16 16:00:00 2026 /bin/xiaoo"
        ) as ps:
            first = hooker_main._process_scope()
            self.assertIsNotNone(first)
            hooker_main._process_scope.cache_clear()
            ps.return_value = "Wed Sep 16 16:01:00 2026 /bin/xiaoo"
            self.assertNotEqual(first, hooker_main._process_scope())

    def test_non_xiaoo_parent_and_missing_process_are_rejected(self) -> None:
        with patch.object(hooker_main.subprocess, "check_output", return_value="Wed Sep 16 16:00:00 2026 /bin/sh"):
            self.assertIsNone(hooker_main._process_scope())
        hooker_main._process_scope.cache_clear()
        with patch.object(hooker_main.subprocess, "check_output", side_effect=OSError("unavailable")):
            self.assertIsNone(hooker_main._process_scope())


if __name__ == "__main__":
    unittest.main()
