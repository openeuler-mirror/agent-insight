# coding: utf-8
from __future__ import annotations

from core.config import AgentRASConfig
from detectors.llm_thinking_loop import LlmThinkingLoopDetector
from detectors.registry import build_member_detectors
from detectors.repeat_tool import RepeatToolCallDetector
from ras_runtime.session_hub import SessionState


def test_build_member_detectors_respects_enabled() -> None:
    config = AgentRASConfig()
    config.detectors.repeat_tool.enabled = False
    config.detectors.llm_thinking_loop.enabled = False
    dets = build_member_detectors(config)
    assert dets == []


def test_build_member_detectors_partial_enabled() -> None:
    config = AgentRASConfig()
    config.detectors.repeat_tool.enabled = True
    config.detectors.llm_thinking_loop.enabled = False
    dets = build_member_detectors(config)
    kinds = {type(d) for d in dets}
    assert RepeatToolCallDetector in kinds
    assert LlmThinkingLoopDetector not in kinds


def test_session_hub_gating_consistent_with_registry() -> None:
    """SessionHub 与 Monitor 同一注册入口：config 关停即不安装，无协议侧特权。"""
    state = SessionState.create(
        "s1",
        "unknown_platform",
        {"llm_thinking_loop": {"enabled": False}},
    )
    assert not any(isinstance(d, LlmThinkingLoopDetector) for d in state.detectors)

    state_on = SessionState.create(
        "s2",
        "unknown_platform",
        {"llm_thinking_loop": {"enabled": True}},
    )
    assert any(isinstance(d, LlmThinkingLoopDetector) for d in state_on.detectors)


def test_session_hub_nested_domain_config_ignores_flat_fields() -> None:
    """嵌套域块生效；顶层同名字段不再广播到域。"""
    nested = SessionState.create(
        "s3",
        "unknown_platform",
        {"enabled": False, "repeat_tool": {"enabled": True, "warning_threshold": 7}},
    )
    repeat = next(
        (d for d in nested.detectors if isinstance(d, RepeatToolCallDetector)),
        None,
    )
    assert repeat is not None
    assert repeat._config.warning_threshold == 7

    ignored = SessionState.create(
        "s4",
        "unknown_platform",
        {"warning_threshold": 99, "detection_start_chars": 1},
    )
    repeat_flat = next(
        (d for d in ignored.detectors if isinstance(d, RepeatToolCallDetector)),
        None,
    )
    thinking = next(
        (d for d in ignored.detectors if isinstance(d, LlmThinkingLoopDetector)),
        None,
    )
    assert repeat_flat is not None
    assert thinking is not None
    assert repeat_flat._config.warning_threshold == 5
    assert thinking._config.detection_start_chars == 30000
