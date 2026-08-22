# coding: utf-8
"""Unit tests for collector session resolution (no network)."""
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

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
        import os
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            os.environ["AGENT_INSIGHT_XIAOO_OTEL_BUF"] = tmp
            try:
                remembered = hooker_main.resolve_session_key(
                    {"session_id": "bbbbbbbb-cccc-dddd-eeee-ffffffffffff"}
                )
                self.assertEqual(remembered, "xiaoo:bbbbbbbb-cccc-dddd-eeee-ffffffffffff")
                sticky = hooker_main.resolve_session_key({}, allow_sticky=True)
                self.assertEqual(sticky, remembered)
                self.assertIsNone(hooker_main.resolve_session_key({}, allow_sticky=False))
            finally:
                os.environ.pop("AGENT_INSIGHT_XIAOO_OTEL_BUF", None)


if __name__ == "__main__":
    unittest.main()
