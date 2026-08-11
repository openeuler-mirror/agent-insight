# coding: utf-8
"""Shared detector registry for Monitor (deep) and SessionHub (protocol).

Domain plugins are discovered by ``detectors.loader``; this module keeps the
public factory surface and wire-compat constants.
"""
from __future__ import annotations

from detectors.loader import (
    build_member_detectors,
    detector_config_models,
)
from detectors.skill_verdicts import SkillVerdict, parse_skill_verdict

# Domain whose config may arrive as flat top-level payload keys (back-compat
# with the original protocol wire format). New domains use nested dicts only.
FLAT_PAYLOAD_DOMAIN = "llm_thinking_loop"


def parse_recovery_verdict(skill_name: str, result: dict) -> SkillVerdict:
    """Parse an L3 review-skill verdict; registry seam so Monitor stays off detector internals."""
    return parse_skill_verdict(skill_name, result)


__all__ = [
    "FLAT_PAYLOAD_DOMAIN",
    "build_member_detectors",
    "detector_config_models",
    "parse_recovery_verdict",
]
