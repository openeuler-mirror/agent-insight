# coding: utf-8
"""Recovery operations via FakeHostControl (no openjiuwen)."""
from __future__ import annotations

import pytest

from core.host_control import HostControl
from core.models import Anomaly, AnomalyKind, Severity
from core.recovery.engine import LocalAutoRecovery, RecoveryPolicy
from core.recovery.operations import (
    apply_recovery_actions,
    build_recovery_actions,
    emit_user_notice,
    inject_steering,
    terminate,
)
from core.recovery.robustness_prompt import format_steering


class FakeHost:
    def __init__(self) -> None:
        self.aborts = 0
        self.steers: list[str] = []
        self.notices: list[str] = []
        self.errors: list[str] = []
        self.finishes: list[dict] = []
        self.writes: list[tuple[str, str]] = []

    def request_abort_stream(self) -> None:
        self.aborts += 1

    def push_steering(self, message: str) -> None:
        self.steers.append(message)

    def request_force_finish(self, payload: dict) -> None:
        self.finishes.append(payload)

    async def emit_user_notice(self, message: str) -> None:
        self.notices.append(message)

    async def emit_stream_error(self, message: str) -> None:
        self.errors.append(message)

    async def write_stream_content(self, chunk_type: str, content: str) -> None:
        self.writes.append((chunk_type, content))


@pytest.mark.asyncio
async def test_inject_steering_uses_envelope() -> None:
    host = FakeHost()
    await inject_steering(host, "fix it")
    assert len(host.steers) == 1
    assert host.steers[0] == format_steering("fix it")


@pytest.mark.asyncio
async def test_emit_user_notice_delegates() -> None:
    host = FakeHost()
    await emit_user_notice(host, "hello")
    assert host.notices == ["hello"]


@pytest.mark.asyncio
async def test_terminate_force_finishes() -> None:
    host = FakeHost()
    await terminate(host, "done", write_error_stream=True)
    assert host.errors == ["done"]
    assert host.finishes and host.finishes[0]["result_type"] == "error"


def test_fake_is_host_control() -> None:
    assert isinstance(FakeHost(), HostControl)


@pytest.mark.asyncio
async def test_apply_recovery_actions_maps_wire() -> None:
    host = FakeHost()
    await apply_recovery_actions(
        host,
        [
            {"type": "abort_stream"},
            {"type": "emit_notice", "message": "n1"},
            {"type": "push_steering", "message": "s1"},
        ],
    )
    assert host.aborts == 1
    assert host.notices == ["n1"]
    assert host.steers == [format_steering("s1")]


def test_build_recovery_actions_thinking_loop() -> None:
    anomaly = Anomaly(
        detector="llm_thinking_loop",
        kind=AnomalyKind.LLM_THINKING_LOOP,
        severity=Severity.MEDIUM,
        member_name="m",
        summary="loop",
        evidence={
            "mode": "similar_clauses",
            "channel": "text_repetition",
            "recovery_profile": "thinking_loop_text_rep",
            "count": 8,
        },
    )
    policy = RecoveryPolicy()
    actions = build_recovery_actions(
        anomaly,
        locale="cn",
        policy=policy,
        auto=LocalAutoRecovery(policy),
    )
    types = [a["type"] for a in actions]
    assert types[0] == "abort_stream"
    assert "emit_notice" in types
    assert "push_steering" in types
    steer = next(a["message"] for a in actions if a["type"] == "push_steering")
    assert "<system-reminder>" in steer
