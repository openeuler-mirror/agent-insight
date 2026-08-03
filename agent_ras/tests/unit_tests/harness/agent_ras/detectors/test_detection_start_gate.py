# coding: utf-8
# Copyright (c) Huawei Technologies Co., Ltd. 2026. All rights reserved.
"""Unit tests for thinking-loop detection_start_chars gate and L3 stream scope."""
from __future__ import annotations

import asyncio

import pytest

from core.config import LlmThinkingLoopConfig
from core.detectors.llm_thinking_loop import LlmThinkingLoopDetector
from core.models import Signal, SignalKind


class _CaptureAgents:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, str, float]] = []

    async def invoke_skill(
        self, *, role: str, skill_name: str, payload: str, timeout: float,
    ):
        self.calls.append((role, skill_name, payload, timeout))
        return {"abnormal": False, "primary_fault": "none"}


@pytest.mark.asyncio
async def test_detection_skipped_before_start_chars() -> None:
    agents = _CaptureAgents()
    cfg = LlmThinkingLoopConfig(
        enabled=True,
        detection_start_chars=50,
        window_max_chars=100,
        semantic_eval_chars=10,
        semantic_content_enabled=True,
    )
    det = LlmThinkingLoopDetector(config=cfg, agents=agents)
    await det.observe(
        Signal(
            kind=SignalKind.STREAM_CHUNK,
            member_name="m",
            chunk_type="llm_reasoning",
            chunk_text="x" * 40,
        )
    )
    await asyncio.sleep(0.02)
    assert agents.calls == []


@pytest.mark.asyncio
async def test_l3_detection_starts_on_reasoning_after_start_chars() -> None:
    agents = _CaptureAgents()
    cfg = LlmThinkingLoopConfig(
        enabled=True,
        detection_start_chars=50,
        window_max_chars=200,
        semantic_eval_chars=50,
        semantic_content_enabled=True,
    )
    det = LlmThinkingLoopDetector(config=cfg, agents=agents)
    await det.observe(
        Signal(
            kind=SignalKind.STREAM_CHUNK,
            member_name="m",
            chunk_type="llm_reasoning",
            chunk_text="x" * 50,
        )
    )
    await asyncio.sleep(0.05)
    assert any(role == "detection" for role, *_ in agents.calls)


@pytest.mark.asyncio
async def test_l3_runs_on_llm_output_temporarily() -> None:
    agents = _CaptureAgents()
    cfg = LlmThinkingLoopConfig(
        enabled=True,
        detection_start_chars=10,
        window_max_chars=200,
        semantic_eval_chars=20,
        semantic_content_enabled=True,
    )
    det = LlmThinkingLoopDetector(config=cfg, agents=agents)
    await det.observe(
        Signal(
            kind=SignalKind.STREAM_CHUNK,
            member_name="m",
            chunk_type="llm_output",
            chunk_text="x" * 100,
        )
    )
    await asyncio.sleep(0.05)
    assert any(role == "detection" for role, *_ in agents.calls)
