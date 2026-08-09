# coding: utf-8
# Copyright (c) Huawei Technologies Co., Ltd. 2026. All rights reserved.
"""Tests for standard steering ``<system-reminder>`` envelope."""
from __future__ import annotations

from core.models import Anomaly, AnomalyKind, Severity
from recovery.robustness_prompt import (
    format_steering,
    generic_steer_text_for,
    recovery_steering_on_abnormal,
    steer_text_for,
)
from recovery.state import PendingRecovery


def test_format_steering_wraps_body() -> None:
    out = format_steering("hello")
    assert out.startswith("<system-reminder>\n")
    assert out.endswith("\n</system-reminder>")
    assert "hello" in out


def test_format_steering_idempotent() -> None:
    once = format_steering("body")
    twice = format_steering(once)
    assert once == twice
    assert twice.count("<system-reminder>") == 1


def test_steer_text_for_uses_envelope() -> None:
    anomaly = Anomaly(
        detector="repeat_tool",
        kind=AnomalyKind.REPEAT_TOOL_CALL,
        severity=Severity.MEDIUM,
        member_name="read_file",
        summary="repeat",
        evidence={
            "msg_key": "generic_repeat",
            "count": 3,
            "tool_arguments": "{}",
        },
    )
    text = steer_text_for(anomaly, locale="cn")
    assert text is not None
    assert text.startswith("<system-reminder>\n")
    assert "</system-reminder>" in text
    assert "read_file" in text
    # template body must not embed a second envelope
    assert text.count("<system-reminder>") == 1


def test_recovery_steering_on_abnormal_uses_envelope() -> None:
    pending = PendingRecovery(
        source="text_repetition",
        recovery_profile="thinking_loop_text_rep",
        mode="suffix_cycle",
        count=5,
        scanned_text="abc" * 20,
    )
    text = recovery_steering_on_abnormal(pending, locale="cn")
    assert text.startswith("<system-reminder>\n")
    assert "[思考循环锁定]" in text
    assert "自动恢复" not in text
    assert "abcabc" not in text
    assert "立刻停止" in text
    assert "执行策略" in text
    assert "再评估是否继续任务" in text


def test_generic_steer_uses_envelope() -> None:
    anomaly = Anomaly(
        detector="x",
        kind=AnomalyKind.LLM_THINKING_LOOP,
        severity=Severity.LOW,
        member_name="m",
        summary="s",
    )
    text = generic_steer_text_for(anomaly, locale="cn")
    assert text.startswith("<system-reminder>\n")
