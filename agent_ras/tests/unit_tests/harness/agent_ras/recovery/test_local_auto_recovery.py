# coding: utf-8
# Copyright (c) Huawei Technologies Co., Ltd. 2026. All rights reserved.
"""Unit tests for LocalAutoRecovery per-invoke rate limit."""
from __future__ import annotations

from core.models import Anomaly, Severity
from recovery.engine import (
    LocalAutoRecovery,
    RecoveryAction,
    RecoveryPolicy,
    _MAX_AUTO_ACTIONS_PER_INVOKE,
)


def _anomaly() -> Anomaly:
    return Anomaly(
        detector="repeat_tool",
        kind="repeat_tool_call",
        severity=Severity.LOW,
        member_name="m",
        summary="repeat",
        evidence={},
    )


def test_allow_caps_per_invoke_then_blocks() -> None:
    auto = LocalAutoRecovery(RecoveryPolicy())
    action = RecoveryAction.INJECT_STEERING
    for _ in range(_MAX_AUTO_ACTIONS_PER_INVOKE):
        assert auto.allow(action) is True
    assert auto.allow(action) is False


def test_reset_clears_per_invoke_counters() -> None:
    auto = LocalAutoRecovery(RecoveryPolicy())
    action = RecoveryAction.INJECT_STEERING
    for _ in range(_MAX_AUTO_ACTIONS_PER_INVOKE):
        auto.allow(action)
    assert auto.allow(action) is False
    auto.reset()
    assert auto.allow(action) is True


def test_steer_message_stops_after_cap() -> None:
    policy = RecoveryPolicy(
        severity_actions={
            Severity.LOW: [RecoveryAction.INJECT_STEERING],
        },
    )
    auto = LocalAutoRecovery(policy)
    anomaly = _anomaly()
    texts = [auto.steer_message(anomaly) for _ in range(_MAX_AUTO_ACTIONS_PER_INVOKE)]
    assert all(t for t in texts)
    assert auto.steer_message(anomaly) is None
