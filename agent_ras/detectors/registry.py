# coding: utf-8
"""Shared detector registry for Monitor (deep) and SessionHub (protocol)."""
from __future__ import annotations

from typing import Callable

from agents.base import NoOpAgentAdapter
from agents.ras_agents import RASAgents
from core.config import AgentRASConfig
from detectors.base import Detector
from detectors.llm_thinking_loop import LlmThinkingLoopDetector
from detectors.repeat_tool import RepeatToolCallDetector


def _build_repeat_tool(
    config: AgentRASConfig,
    agents: RASAgents,
) -> Detector | None:
    del agents
    if not config.detectors.repeat_tool.enabled:
        return None
    return RepeatToolCallDetector(config.detectors.repeat_tool)


def _build_llm_thinking_loop(
    config: AgentRASConfig,
    agents: RASAgents,
) -> Detector | None:
    if not config.detectors.llm_thinking_loop.enabled:
        return None
    return LlmThinkingLoopDetector(
        config.detectors.llm_thinking_loop,
        agents=agents,
    )


DETECTOR_BUILDERS: list[
    tuple[str, Callable[[AgentRASConfig, RASAgents], Detector | None]]
] = [
    ("repeat_tool", _build_repeat_tool),
    ("llm_thinking_loop", _build_llm_thinking_loop),
]


def build_member_detectors(
    config: AgentRASConfig,
    agents: RASAgents | None = None,
    *,
    force_thinking_loop: bool = False,
) -> list[Detector]:
    """Build enabled detectors via the registry.

    ``force_thinking_loop``: protocol SessionHub historically always installs
    the thinking-loop detector even when config disables it. Prefer False for
    new callers; SessionHub passes True for back-compat.
    """
    agents = agents or RASAgents(NoOpAgentAdapter())
    detectors: list[Detector] = []
    for name, build in DETECTOR_BUILDERS:
        if name == "llm_thinking_loop" and force_thinking_loop:
            detectors.append(
                LlmThinkingLoopDetector(config.detectors.llm_thinking_loop, agents=agents)
            )
            continue
        detector = build(config, agents)
        if detector is not None:
            detectors.append(detector)
    return detectors


__all__ = ["DETECTOR_BUILDERS", "build_member_detectors"]
