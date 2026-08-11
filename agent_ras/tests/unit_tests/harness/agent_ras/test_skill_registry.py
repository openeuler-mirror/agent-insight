# coding: utf-8
# Copyright (c) Huawei Technologies Co., Ltd. 2026. All rights reserved.
"""Unit tests for fault-domain skill registry."""
from __future__ import annotations

import pytest

from agents.base import (
    FAULT_DOMAIN_LLM_THINKING_LOOP,
    fault_domain_for_kind,
    skill_for,
)
from core.models import AnomalyKind


def test_fault_domain_for_thinking_loop_kinds() -> None:
    assert (
        fault_domain_for_kind(AnomalyKind.LLM_THINKING_LOOP)
        == FAULT_DOMAIN_LLM_THINKING_LOOP
    )
    assert (
        fault_domain_for_kind(AnomalyKind.LLM_THINKING_DEAD_LOOP)
        == FAULT_DOMAIN_LLM_THINKING_LOOP
    )
    assert fault_domain_for_kind("llm_thinking_loop") == FAULT_DOMAIN_LLM_THINKING_LOOP
    assert fault_domain_for_kind(AnomalyKind.REPEAT_TOOL_CALL) == "repeat_tool"
    assert fault_domain_for_kind("unknown") is None


def test_skill_for_llm_thinking_loop() -> None:
    assert (
        skill_for(FAULT_DOMAIN_LLM_THINKING_LOOP, "detection")
        == "llm-loop-detection"
    )
    assert (
        skill_for(FAULT_DOMAIN_LLM_THINKING_LOOP, "review")
        == "llm-loop-review"
    )


def test_skill_for_unknown_raises() -> None:
    with pytest.raises(ValueError, match="unknown fault domain"):
        skill_for("no_such_domain", "detection")
    with pytest.raises(ValueError, match="unknown role"):
        skill_for(FAULT_DOMAIN_LLM_THINKING_LOOP, "reviewer")
