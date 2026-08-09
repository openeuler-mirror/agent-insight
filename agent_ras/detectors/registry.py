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
from detectors.skill_verdicts import SkillVerdict, parse_skill_verdict


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
) -> list[Detector]:
    """Build enabled detectors via the registry (single entry for Monitor and SessionHub)."""
    agents = agents or RASAgents(NoOpAgentAdapter())
    detectors: list[Detector] = []
    for _name, build in DETECTOR_BUILDERS:
        detector = build(config, agents)
        if detector is not None:
            detectors.append(detector)
    return detectors


# Domain whose config may arrive as flat top-level payload keys (back-compat
# with the original protocol wire format). New domains use nested dicts only.
FLAT_PAYLOAD_DOMAIN = "llm_thinking_loop"


def detector_config_models() -> dict[str, type]:
    """Map registered domain name to its config model class (from AgentRASConfig)."""
    probe = AgentRASConfig().detectors
    return {name: type(getattr(probe, name)) for name, _ in DETECTOR_BUILDERS}


def parse_recovery_verdict(skill_name: str, result: dict) -> SkillVerdict:
    """Parse an L3 recovery-skill verdict; registry seam so Monitor stays off detector internals."""
    return parse_skill_verdict(skill_name, result)


__all__ = [
    "DETECTOR_BUILDERS",
    "FLAT_PAYLOAD_DOMAIN",
    "build_member_detectors",
    "detector_config_models",
    "parse_recovery_verdict",
]
