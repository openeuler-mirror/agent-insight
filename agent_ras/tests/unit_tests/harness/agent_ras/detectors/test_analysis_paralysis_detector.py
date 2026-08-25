# coding: utf-8
"""AnalysisParalysisDetector: sliding-window gate → Skill, fail-open, async recovery."""
from __future__ import annotations

import asyncio

import pytest

from core.models import Severity, Signal, SignalKind
from agents.base import fault_domain_for_kind, skill_for
from detectors.analysis_paralysis import (
    FAULT_DOMAIN_ANALYSIS_PARALYSIS,
    KIND_ANALYSIS_PARALYSIS,
    PRESENTATION_ANALYSIS_PARALYSIS,
    AnalysisParalysisConfig,
    AnalysisParalysisDetector,
    parse_analysis_paralysis_verdict,
)
from detectors.loader import (
    DOMAIN_SKILLS,
    KIND_TO_DOMAIN,
    ensure_domains_loaded,
    is_stream_kind,
)


def _stream_chunk(text: str, chunk_type: str = "llm_output", member: str = "m") -> Signal:
    return Signal(
        kind=SignalKind.STREAM_CHUNK,
        member_name=member,
        chunk_type=chunk_type,
        chunk_text=text,
    )


class _CaptureAgents:
    def __init__(self, *, response: dict | None = None):
        self.calls: list[tuple[str, str, str, float]] = []
        self._response = response if response is not None else {
            "abnormal": True,
            "primary_fault": "analysis_paralysis",
            "confidence": 0.9,
            "rationale": "stalled",
        }

    async def invoke_skill(self, *, role: str, skill_name: str, payload: str, timeout: float):
        self.calls.append((role, skill_name, payload, timeout))
        return self._response


def _gated_text() -> str:
    """Text that produces ≥10 trigger hits within the sliding window."""
    step = (
        "Wait, let me check. Wait, hold on. "
        "Let me double check. Wait a moment. "
        "Let me re-read. Wait, let me check. "
    )
    return "\n\n".join([step, step])


@pytest.mark.asyncio
async def test_below_start_chars_does_not_invoke_skill() -> None:
    agents = _CaptureAgents()
    det = AnalysisParalysisDetector(
        AnalysisParalysisConfig(detection_start_chars=50000),
        agents=agents,
    )
    await det.observe(_stream_chunk(_gated_text()))
    await asyncio.sleep(0)
    assert agents.calls == []


@pytest.mark.asyncio
async def test_below_threshold_does_not_invoke() -> None:
    agents = _CaptureAgents()
    det = AnalysisParalysisDetector(
        AnalysisParalysisConfig(
            detection_start_chars=1,
            trigger_count_threshold=10,
        ),
        agents=agents,
    )
    await det.observe(_stream_chunk("Wait, let me check this.\n\nmore\n\n"))
    await asyncio.sleep(0)
    assert agents.calls == []


@pytest.mark.asyncio
async def test_gate_then_skill_abnormal_emits_anomaly() -> None:
    agents = _CaptureAgents()
    captured: list = []

    async def _handler(anomaly, chunk_type):
        captured.append((anomaly, chunk_type))

    det = AnalysisParalysisDetector(
        AnalysisParalysisConfig(detection_start_chars=1),
        agents=agents,
    )
    det.set_async_recovery_handler(_handler)
    await det.observe(_stream_chunk(_gated_text()))
    await det.await_async_recovery(2.0)
    assert len(agents.calls) == 1
    role, skill_name, payload, _timeout = agents.calls[0]
    assert role == "detection"
    assert skill_name == "analysis-paralysis-detection"
    assert "## current_step" in payload
    assert captured
    anomaly, chunk_type = captured[0]
    assert chunk_type == "llm_output"
    assert anomaly.kind == KIND_ANALYSIS_PARALYSIS
    assert anomaly.severity == Severity.MEDIUM
    assert anomaly.evidence.get("needs_l3_review") is False
    assert anomaly.evidence.get("primary_fault") == "analysis_paralysis"
    assert anomaly.evidence.get("channel") == "refrain_gate"
    assert "trigger_hits" in anomaly.evidence
    assert "window_hit_count" in anomaly.evidence
    assert "trigger_count_threshold" in anomaly.evidence


@pytest.mark.asyncio
async def test_skill_none_fail_open_no_anomaly() -> None:
    agents = _CaptureAgents(
        response={"abnormal": False, "primary_fault": "none", "rationale": "progress"},
    )
    captured: list = []

    async def _handler(anomaly, chunk_type):
        captured.append(anomaly)

    det = AnalysisParalysisDetector(
        AnalysisParalysisConfig(detection_start_chars=1),
        agents=agents,
    )
    det.set_async_recovery_handler(_handler)
    await det.observe(_stream_chunk(_gated_text()))
    await det.await_async_recovery(2.0)
    assert agents.calls
    assert captured == []
    assert det.has_async_recovery_in_flight() is False


@pytest.mark.asyncio
async def test_invalid_skill_payload_fail_open() -> None:
    agents = _CaptureAgents(response={})
    captured: list = []

    async def _handler(anomaly, chunk_type):
        captured.append(anomaly)

    det = AnalysisParalysisDetector(
        AnalysisParalysisConfig(detection_start_chars=1),
        agents=agents,
    )
    det.set_async_recovery_handler(_handler)
    await det.observe(_stream_chunk(_gated_text()))
    await det.await_async_recovery(2.0)
    assert captured == []


@pytest.mark.asyncio
async def test_skill_overthinking_payload_fail_open_no_anomaly() -> None:
    agents = _CaptureAgents(
        response={"abnormal": True, "primary_fault": "overthinking"},
    )
    captured: list = []

    async def _handler(anomaly, chunk_type):
        captured.append(anomaly)

    det = AnalysisParalysisDetector(
        AnalysisParalysisConfig(detection_start_chars=1),
        agents=agents,
    )
    det.set_async_recovery_handler(_handler)
    await det.observe(_stream_chunk(_gated_text()))
    await det.await_async_recovery(2.0)
    assert agents.calls
    assert captured == []


@pytest.mark.asyncio
async def test_low_threshold_single_step_gates() -> None:
    agents = _CaptureAgents()
    captured: list = []

    async def _handler(anomaly, chunk_type):
        captured.append((anomaly, chunk_type))

    det = AnalysisParalysisDetector(
        AnalysisParalysisConfig(
            detection_start_chars=1,
            trigger_count_threshold=2,
        ),
        agents=agents,
    )
    det.set_async_recovery_handler(_handler)
    await det.observe(_stream_chunk("Wait, let me check.\n\n"))
    await det.await_async_recovery(2.0)
    assert len(agents.calls) == 1
    assert captured


def test_parse_rejects_overthinking_and_unknown_fault() -> None:
    verdict = parse_analysis_paralysis_verdict(
        {"abnormal": True, "primary_fault": "overthinking"},
    )
    assert verdict.abnormal is False
    assert verdict.fail_open_reason == "schema_validation_failed"


def test_parse_inconsistent_abnormal_fail_open() -> None:
    verdict = parse_analysis_paralysis_verdict(
        {"abnormal": True, "primary_fault": "none"},
    )
    assert verdict.fail_open_reason
    assert verdict.abnormal is False


def test_plugin_identity_and_join() -> None:
    ensure_domains_loaded()
    assert KIND_TO_DOMAIN[KIND_ANALYSIS_PARALYSIS] == FAULT_DOMAIN_ANALYSIS_PARALYSIS
    assert fault_domain_for_kind(KIND_ANALYSIS_PARALYSIS) == FAULT_DOMAIN_ANALYSIS_PARALYSIS
    assert is_stream_kind(KIND_ANALYSIS_PARALYSIS)
    assert (
        skill_for(FAULT_DOMAIN_ANALYSIS_PARALYSIS, "detection")
        == "analysis-paralysis-detection"
    )
    skills = DOMAIN_SKILLS.get(FAULT_DOMAIN_ANALYSIS_PARALYSIS, {})
    assert "review" not in skills
    with pytest.raises(ValueError, match="unknown role"):
        skill_for(FAULT_DOMAIN_ANALYSIS_PARALYSIS, "review")
    sm = PRESENTATION_ANALYSIS_PARALYSIS.submodes[0]
    assert sm.id == "refrain_gate"
    assert sm.parent_id == FAULT_DOMAIN_ANALYSIS_PARALYSIS
    assert sm.anomaly_kind == KIND_ANALYSIS_PARALYSIS
