# coding: utf-8
"""Review plugin for llm_thinking_loop (L3 semantic judge)."""
from __future__ import annotations

from detectors.types import ReviewPlugin

REVIEW_PLUGIN = ReviewPlugin(
    id="llm_thinking_loop",
    review_skill="llm-loop-review",
)

__all__ = ["REVIEW_PLUGIN"]
