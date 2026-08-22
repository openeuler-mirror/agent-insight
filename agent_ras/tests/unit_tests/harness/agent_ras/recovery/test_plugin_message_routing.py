# coding: utf-8
"""Plugin-owned terminate_kinds (no framework domain names)."""
from __future__ import annotations

from detectors.loader import (
    ensure_domains_loaded,
    recovery_terminate_kinds,
    reset_domains_for_tests,
)


def test_builtin_repeat_tool_terminate_kinds() -> None:
    reset_domains_for_tests()
    ensure_domains_loaded(force=True)
    kinds = recovery_terminate_kinds()
    assert "repeat_tool_call" in kinds
    assert "tool_call_loop" in kinds
    assert "llm_thinking_loop" not in kinds
