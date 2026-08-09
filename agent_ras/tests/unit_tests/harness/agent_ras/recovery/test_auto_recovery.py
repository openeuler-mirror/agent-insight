# coding: utf-8
# Copyright (c) Huawei Technologies Co., Ltd. 2026. All rights reserved.
"""Automatic thinking-loop recovery: L1/L2 immediate abort, L3 Reviewer + fail-open."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from core.config import AgentRASConfig, LlmThinkingLoopConfig
from detectors.llm_thinking_loop import (
    LlmThinkingLoopDetector,
)
from core.models import (
    Anomaly,
    AnomalyKind,
    Severity,
    Signal,
    SignalKind,
)
from core.monitor import AgentRASMonitor
from recovery.engine import (
    RecoveryAction,
    RecoveryExecutor,
    RecoveryPolicy,
)
from recovery.state import PendingRecovery
from platform_adapter.openjiuwen.host_control import host_control_from_ctx


class _CaptureAgents:
    def __init__(
        self,
        *,
        response: dict | None = None,
        role_responses: dict[str, dict] | None = None,
        delay: float = 0.0,
    ):
        self.calls: list[tuple[str, str, str, float]] = []
        self._response = response if response is not None else {
            "abnormal": True,
            "primary_fault": "semantic_deadlock",
            "confidence": 0.9,
            "rationale": "confirmed",
        }
        self._role_responses = role_responses or {}
        self._delay = delay
        self._raise: Exception | None = None

    async def invoke_skill(
        self, *, role: str, skill_name: str, payload: str, timeout: float,
    ):
        self.calls.append((role, skill_name, payload, timeout))
        if self._delay:
            await asyncio.sleep(self._delay)
        if self._raise is not None:
            raise self._raise
        if role in self._role_responses:
            return self._role_responses[role]
        return self._response


def _policy() -> RecoveryPolicy:
    return RecoveryPolicy(
        kind_overrides={
            AnomalyKind.LLM_THINKING_LOOP: [
                RecoveryAction.OBSERVE_ONLY,
                RecoveryAction.SUPPRESS_STREAM,
            ],
            AnomalyKind.LLM_THINKING_DEAD_LOOP: [
                RecoveryAction.OBSERVE_ONLY,
                RecoveryAction.SUPPRESS_STREAM,
            ],
        },
    )


def _ctx() -> SimpleNamespace:
    ctx = SimpleNamespace(
        has_abort_stream_request=False,
        push_steering=MagicMock(),
        steering_queue=object(),  # non-None so inject_steering proceeds to push
        session=SimpleNamespace(write_stream=AsyncMock()),
    )

    def _request_abort_stream() -> None:
        ctx.has_abort_stream_request = True

    ctx.request_abort_stream = MagicMock(side_effect=_request_abort_stream)
    return ctx


def _monitor(agents: _CaptureAgents | None = None) -> AgentRASMonitor:
    executor = RecoveryExecutor(None)
    return AgentRASMonitor(
        detectors=[],
        reporter=None,
        policy=_policy(),
        agents=agents,
        config=AgentRASConfig(),
        executor=executor,
        member_name="m",
        session_id="s",
    )


def _l1_anomaly() -> Anomaly:
    return Anomaly(
        detector="llm_thinking_loop",
        kind=AnomalyKind.LLM_THINKING_LOOP,
        severity=Severity.MEDIUM,
        member_name="m",
        summary="loop",
        evidence={
            "mode": "suffix_cycle",
            "channel": "text_repetition",
            "recovery_profile": "thinking_loop_text_rep",
            "count": 5,
            "start_pos": 0,
            "chunk_type": "llm_output",
            "scanned_text": "abcdefghij" * 5,
            "stream_chunk_keep_len": 0,
        },
    )


def _l3_anomaly() -> Anomaly:
    return Anomaly(
        detector="llm_thinking_loop",
        kind=AnomalyKind.LLM_THINKING_DEAD_LOOP,
        severity=Severity.HIGH,
        member_name="m",
        summary="dead loop",
        evidence={
            "mode": "plan_execution_loop_lock",
            "channel": "plan_execution",
            "recovery_profile": "thinking_loop_plan_exec",
            "chunk_type": "llm_output",
            "thinking_excerpt": "deadlock excerpt " * 20,
            "scanned_text": "deadlock excerpt " * 20,
            "primary_fault": "semantic_deadlock",
            "skill_rationale": "first judge",
            "skill_confidence": 0.8,
            "stream_chunk_keep_len": 0,
        },
    )


@pytest.mark.asyncio
async def test_l1_l2_aborts_without_recovery_skill(caplog) -> None:
    import logging

    agents = _CaptureAgents()
    monitor = _monitor(agents)
    ctx = _ctx()
    chunk = {"payload": {"content": "abcdefghij" * 5}}

    with caplog.at_level(logging.WARNING):
        await monitor.recovery(
            host_control_from_ctx(ctx),
            [_l1_anomaly()],
            phase="stream",
            chunk=chunk,
            chunk_type="llm_output",
            chunk_text="abcdefghij" * 5,
        )
        await monitor._dispatch_automatic_recovery(host_control_from_ctx(ctx))

    ctx.request_abort_stream.assert_called_once()
    ctx.push_steering.assert_called_once()
    assert agents.calls == []
    # Immediate user notice for interrupt reason.
    ctx.session.write_stream.assert_awaited()
    notice = monitor.take_notice()
    assert notice is not None
    # Dedup: same notice already emitted immediately.
    monitor._notice_emitted_immediate = notice
    monitor._executor.schedule_recovery_notice(notice)
    assert monitor.consume_notice_for_emit() is None
    assert monitor._executor.suppress_state.pending is None
    assert monitor._executor.suppress_state.resolved == "abnormal"
    assert any("thinking-loop abort" in r.message for r in caplog.records)


@pytest.mark.asyncio
async def test_l3_recovery_abnormal_aborts(caplog) -> None:
    import logging

    agents = _CaptureAgents(
        response={
            "abnormal": True,
            "primary_fault": "semantic_deadlock",
            "confidence": 0.9,
            "rationale": "confirmed",
        },
    )
    monitor = _monitor(agents)
    ctx = _ctx()
    monitor.bind_host(host_control_from_ctx(ctx))

    with caplog.at_level(logging.WARNING):
        await monitor.complete_async_stream_recovery(_l3_anomaly(), "llm_output")
        await asyncio.sleep(0.05)

    assert any(role == "recovery" for role, *_ in agents.calls)
    assert any(
        role == "recovery" and skill == "llm-loop-review"
        for role, skill, *_ in agents.calls
    )
    assert not any(role == "detection" for role, *_ in agents.calls)
    ctx.request_abort_stream.assert_called_once()
    ctx.push_steering.assert_called_once()
    ctx.session.write_stream.assert_awaited()
    assert monitor.take_notice() is not None
    assert any("thinking-loop abort" in r.message for r in caplog.records)


@pytest.mark.asyncio
async def test_l3_recovery_normal_flushes_without_abort() -> None:
    agents = _CaptureAgents(
        response={
            "abnormal": False,
            "primary_fault": "none",
            "confidence": 0.7,
            "rationale": "false positive",
        },
    )
    monitor = _monitor(agents)
    ctx = _ctx()
    monitor.bind_host(host_control_from_ctx(ctx))
    suppress = monitor._executor.suppress_state
    suppress.record_pending(
        PendingRecovery.from_anomaly(_l3_anomaly()),
    )
    suppress.record_suppressed("llm_output", "buffered-text")

    await monitor._dispatch_automatic_recovery(host_control_from_ctx(ctx))
    await asyncio.sleep(0.05)

    ctx.request_abort_stream.assert_not_called()
    ctx.push_steering.assert_not_called()
    assert monitor.take_notice() is None
    ctx.session.write_stream.assert_awaited()
    assert suppress.pending is None
    assert suppress.resolved == "normal"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "response",
    [
        {},
        {"abnormal": True},  # illegal / incomplete → fail-open via parser
    ],
)
async def test_l3_recovery_invalid_fail_open(response, caplog) -> None:
    import logging

    agents = _CaptureAgents(response=response)
    monitor = _monitor(agents)
    ctx = _ctx()
    monitor.bind_host(host_control_from_ctx(ctx))

    with caplog.at_level(logging.WARNING):
        await monitor.complete_async_stream_recovery(_l3_anomaly(), "llm_output")
        await asyncio.sleep(0.05)

    ctx.request_abort_stream.assert_not_called()
    ctx.push_steering.assert_not_called()
    assert monitor.take_notice() is None
    assert any("fail-open" in r.message for r in caplog.records)


@pytest.mark.asyncio
async def test_l3_recovery_exception_fail_open(caplog) -> None:
    import logging

    agents = _CaptureAgents()
    agents._raise = RuntimeError("boom")
    monitor = _monitor(agents)
    ctx = _ctx()
    monitor.bind_host(host_control_from_ctx(ctx))

    with caplog.at_level(logging.WARNING):
        await monitor.complete_async_stream_recovery(_l3_anomaly(), "llm_output")
        await asyncio.sleep(0.05)

    ctx.request_abort_stream.assert_not_called()
    ctx.push_steering.assert_not_called()
    assert any("recovery failed" in r.message for r in caplog.records)


@pytest.mark.asyncio
async def test_finalize_stream_recovery_fail_open_on_pending_review(
    caplog, monkeypatch,
) -> None:
    import logging

    from core import monitor as monitor_mod

    monkeypatch.setattr(monitor_mod, "SKILL_TIMEOUT_SECONDS", 1.0)
    agents = _CaptureAgents(
        response={
            "abnormal": True,
            "primary_fault": "semantic_deadlock",
        },
        delay=2.0,
    )
    cfg = AgentRASConfig()
    executor = RecoveryExecutor(None)
    monitor = AgentRASMonitor(
        detectors=[],
        reporter=None,
        policy=_policy(),
        agents=agents,
        config=cfg,
        executor=executor,
        member_name="m",
        session_id="s",
    )
    ctx = _ctx()
    monitor.bind_host(host_control_from_ctx(ctx))
    with caplog.at_level(logging.INFO):
        await monitor.complete_async_stream_recovery(_l3_anomaly(), "llm_output")
        # Review still in flight; model call ends → fail-open.
        await monitor.finalize_stream_recovery(host_control_from_ctx(ctx))

    ctx.request_abort_stream.assert_not_called()
    ctx.push_steering.assert_not_called()
    assert executor.suppress_state.resolved == "normal"
    assert any(
        "fail-open" in r.message and "timeout" in r.message
        for r in caplog.records
    )


@pytest.mark.asyncio
async def test_prepare_for_next_model_call_reopens_after_abnormal() -> None:
    monitor = _monitor()
    ctx = _ctx()
    pending = PendingRecovery.from_anomaly(_l1_anomaly())
    monitor._executor.suppress_state.record_pending(pending)
    await monitor._apply_abnormal_recovery(host_control_from_ctx(ctx), pending)

    assert monitor._abnormal_committed is True
    notice = monitor.take_notice()
    assert notice

    monitor.prepare_for_next_model_call()
    assert monitor._abnormal_committed is False
    # Notice already taken; prepare must not re-queue.
    assert monitor.take_notice() is None


@pytest.mark.asyncio
async def test_l3_gate_chars_only_no_time_threshold() -> None:
    agents = _CaptureAgents(
        response={
            "abnormal": True,
            "primary_fault": "semantic_deadlock",
        },
    )
    cfg = LlmThinkingLoopConfig(
        enabled=True,
        detection_start_chars=1,
        semantic_eval_chars=30,
        semantic_content_enabled=True,
    )
    det = LlmThinkingLoopDetector(config=cfg, agents=agents)
    # Ensure default config no longer exposes thinking_timeout_minutes.
    assert not hasattr(AgentRASConfig().detectors.llm_thinking_loop, "thinking_timeout_minutes")
    assert AgentRASConfig().detectors.llm_thinking_loop.detection_start_chars == 30000
    assert AgentRASConfig().detectors.llm_thinking_loop.window_max_chars == 2000
    assert AgentRASConfig().detectors.llm_thinking_loop.semantic_eval_chars == 10000

    text = "x" * 30
    await det.observe(
        Signal(
            kind=SignalKind.STREAM_CHUNK,
            member_name="m",
            chunk_type="llm_reasoning",
            chunk_text=text,
        )
    )
    await asyncio.sleep(0.05)
    assert any(role == "detection" for role, *_ in agents.calls)


@pytest.mark.asyncio
async def test_l3_normal_requires_fresh_chars_before_redetect() -> None:
    agents = _CaptureAgents(
        role_responses={
            "detection": {
                "abnormal": True,
                "primary_fault": "semantic_deadlock",
                "confidence": 0.9,
                "rationale": "first",
            },
            "recovery": {
                "abnormal": False,
                "primary_fault": "none",
                "confidence": 0.8,
                "rationale": "false positive",
            },
        },
    )
    cfg = LlmThinkingLoopConfig(
        enabled=True,
        detection_start_chars=1,
        semantic_eval_chars=20,
        semantic_content_enabled=True,
    )
    det = LlmThinkingLoopDetector(config=cfg, agents=agents)
    monitor = AgentRASMonitor(
        detectors=[det],
        reporter=None,
        policy=_policy(),
        agents=agents,
        config=AgentRASConfig(),
        executor=RecoveryExecutor(None),
        member_name="m",
        session_id="s",
    )
    ctx = _ctx()
    monitor.bind_host(host_control_from_ctx(ctx))
    det.set_async_recovery_handler(monitor.complete_async_stream_recovery)

    await det.observe(
        Signal(
            kind=SignalKind.STREAM_CHUNK,
            member_name="m",
            chunk_type="llm_reasoning",
            chunk_text="a" * 20,
        )
    )
    # Wait for detection + recovery normal path (releases L3 latch / advances cursor).
    for _ in range(50):
        if any(c[0] == "recovery" for c in agents.calls):
            break
        await asyncio.sleep(0.02)
    await asyncio.sleep(0.05)

    detection_calls = [c for c in agents.calls if c[0] == "detection"]
    assert len(detection_calls) == 1
    ctx.request_abort_stream.assert_not_called()

    # Without enough new chars, no second detection.
    await det.observe(
        Signal(
            kind=SignalKind.STREAM_CHUNK,
            member_name="m",
            chunk_type="llm_reasoning",
            chunk_text="b" * 5,
        )
    )
    await asyncio.sleep(0.05)
    assert len([c for c in agents.calls if c[0] == "detection"]) == 1

    # Fresh window of 20 chars triggers again.
    await det.observe(
        Signal(
            kind=SignalKind.STREAM_CHUNK,
            member_name="m",
            chunk_type="llm_reasoning",
            chunk_text="c" * 20,
        )
    )
    await asyncio.sleep(0.05)
    assert len([c for c in agents.calls if c[0] == "detection"]) >= 2


@pytest.mark.asyncio
async def test_apply_abnormal_recovery_uses_active_ctx(monkeypatch) -> None:
    """Abort / steering / notice must target _active_ctx, not a stale param (ZZP-001)."""
    from recovery import operations as ops
    import core.monitor as monitor_mod

    monitor = _monitor()
    active = _ctx()
    other = _ctx()
    monitor.bind_host(host_control_from_ctx(active))
    pending = PendingRecovery.from_anomaly(_l1_anomaly())
    monitor._executor.suppress_state.record_pending(pending)

    async def fake_inject(host, steering):
        host.push_steering(steering)

    async def fake_notice(host, message):
        await host.emit_user_notice(message)

    monkeypatch.setattr(ops, "inject_steering", fake_inject)
    monkeypatch.setattr(monitor_mod, "emit_user_notice", fake_notice)

    await monitor._apply_abnormal_recovery(other, pending)

    active.request_abort_stream.assert_called_once()
    other.request_abort_stream.assert_not_called()
    active.push_steering.assert_called_once()
    other.push_steering.assert_not_called()
    active.session.write_stream.assert_awaited()
    other.session.write_stream.assert_not_awaited()
    assert monitor._abnormal_committed


@pytest.mark.asyncio
async def test_abnormal_recovery_cancel_then_finalize_completes_abnormal(
    monkeypatch,
) -> None:
    """Cancel mid abnormal recovery: finalize re-enters and commits (ZZP-004)."""
    from recovery import operations as ops

    monitor = _monitor()
    ctx = _ctx()
    monitor.bind_host(host_control_from_ctx(ctx))
    pending = PendingRecovery.from_anomaly(_l3_anomaly())
    suppress = monitor._executor.suppress_state
    suppress.record_pending(pending)

    steer_calls: list[str] = []

    async def cancel_once_then_ok(_ctx, steering):
        steer_calls.append(steering)
        if len(steer_calls) == 1:
            raise asyncio.CancelledError()

    monkeypatch.setattr(ops, "inject_steering", cancel_once_then_ok)

    with pytest.raises(asyncio.CancelledError):
        await monitor._apply_abnormal_recovery(host_control_from_ctx(ctx), pending)

    assert not monitor._abnormal_committed
    assert monitor._abnormal_interrupted
    assert suppress.pending is not None
    assert suppress.resolved is None
    ctx.request_abort_stream.assert_called_once()

    await monitor.finalize_stream_recovery(host_control_from_ctx(ctx))

    assert monitor._abnormal_committed
    assert not monitor._abnormal_interrupted
    assert suppress.resolved == "abnormal"
    assert suppress.pending is None
    assert len(steer_calls) == 2
    # Second abort skipped while has_abort_stream_request remains True.
    ctx.request_abort_stream.assert_called_once()
    ctx.session.write_stream.assert_awaited()


@pytest.mark.asyncio
async def test_finalize_interrupted_abnormal_pending_none_degrades() -> None:
    """Interrupted with pending lost: degrade to normal + notice (ZZP-004)."""
    from recovery.robustness_prompt import (
        interrupted_abnormal_degrade_user_notice,
    )

    monitor = _monitor()
    ctx = _ctx()
    monitor.bind_host(host_control_from_ctx(ctx))
    suppress = monitor._executor.suppress_state
    monitor._abnormal_interrupted = True
    # pending already gone — cannot re-enter abnormal recovery
    assert suppress.pending is None
    assert suppress.resolved is None

    await monitor.finalize_stream_recovery(host_control_from_ctx(ctx))

    assert suppress.resolved == "normal"
    assert not monitor._abnormal_committed
    assert not monitor._abnormal_interrupted
    ctx.session.write_stream.assert_awaited()
    expected = interrupted_abnormal_degrade_user_notice("cn")
    assert monitor._notice_emitted_immediate == expected
    assert monitor.take_notice() == expected


@pytest.mark.asyncio
async def test_finalize_interrupted_with_pending_reinjects_steering(
    monkeypatch,
) -> None:
    """interrupted + pending → finalize completes abnormal and injects steering."""
    from recovery import operations as ops

    monitor = _monitor()
    ctx = _ctx()
    monitor.bind_host(host_control_from_ctx(ctx))
    pending = PendingRecovery.from_anomaly(_l3_anomaly())
    suppress = monitor._executor.suppress_state
    suppress.record_pending(pending)
    # Simulate abort-without-commit interruption without running apply.
    ctx.has_abort_stream_request = True
    monitor._abnormal_interrupted = True

    steer_calls: list[str] = []

    async def capture_steering(_ctx, steering):
        steer_calls.append(steering)

    monkeypatch.setattr(ops, "inject_steering", capture_steering)

    await monitor.finalize_stream_recovery(host_control_from_ctx(ctx))

    assert monitor._abnormal_committed
    assert suppress.resolved == "abnormal"
    assert len(steer_calls) == 1
    assert steer_calls[0]
    ctx.request_abort_stream.assert_not_called()
