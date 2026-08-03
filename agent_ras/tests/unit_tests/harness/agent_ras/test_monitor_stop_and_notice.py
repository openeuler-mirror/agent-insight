# coding: utf-8
# Copyright (c) Huawei Technologies Co., Ltd. 2026. All rights reserved.
"""Unit tests for AgentRASMonitor.stop / emit_user_notice CR fixes."""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from core.config import AgentRASConfig
from core.detectors.repeat_tool import RepeatToolCallDetector
from core.monitor import AgentRASMonitor
from core.recovery.engine import RecoveryExecutor, RecoveryPolicy
from core.recovery.operations import emit_user_notice
from platform_adapter.openjiuwen.host_control import host_control_from_ctx


def _monitor_with_repeat() -> tuple[AgentRASMonitor, RepeatToolCallDetector]:
    detector = RepeatToolCallDetector()
    detector._locks["s1"] = MagicMock()  # type: ignore[assignment]
    monitor = AgentRASMonitor(
        detectors=[detector],
        reporter=None,
        policy=RecoveryPolicy(),
        agents=None,
        config=AgentRASConfig(),
        executor=RecoveryExecutor(None),
        member_name="m",
        session_id="s",
    )
    return monitor, detector


@pytest.mark.asyncio
async def test_monitor_stop_resets_detectors() -> None:
    """stop() must call reset_detectors so locks/histories do not leak (CR-004)."""
    monitor, detector = _monitor_with_repeat()
    monitor._started = True
    monitor._stopped = False
    assert "s1" in detector._locks

    await monitor.stop()

    assert detector._locks == {}
    assert monitor.stopped


@pytest.mark.asyncio
async def test_emit_user_notice_uses_index_minus_one() -> None:
    """User notice stream index should be -1, not a hardcoded 999 (CR-005)."""
    write_stream = AsyncMock()
    ctx = SimpleNamespace(session=SimpleNamespace(write_stream=write_stream))

    await emit_user_notice(host_control_from_ctx(ctx), "hello")

    write_stream.assert_awaited_once()
    schema = write_stream.await_args.args[0]
    assert schema.index == -1
