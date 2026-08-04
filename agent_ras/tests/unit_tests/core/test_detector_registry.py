# coding: utf-8
from __future__ import annotations

from core.config import AgentRASConfig
from core.detectors.llm_thinking_loop import LlmThinkingLoopDetector
from core.detectors.registry import build_member_detectors
from core.detectors.repeat_tool import RepeatToolCallDetector


def test_build_member_detectors_respects_enabled() -> None:
    config = AgentRASConfig()
    config.detectors.repeat_tool.enabled = False
    config.detectors.llm_thinking_loop.enabled = False
    dets = build_member_detectors(config)
    assert dets == []


def test_build_member_detectors_force_thinking_loop() -> None:
    config = AgentRASConfig()
    config.detectors.repeat_tool.enabled = True
    config.detectors.llm_thinking_loop.enabled = False
    dets = build_member_detectors(config, force_thinking_loop=True)
    kinds = {type(d) for d in dets}
    assert RepeatToolCallDetector in kinds
    assert LlmThinkingLoopDetector in kinds
