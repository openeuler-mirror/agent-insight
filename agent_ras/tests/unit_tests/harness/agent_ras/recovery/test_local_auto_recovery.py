# coding: utf-8
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

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
