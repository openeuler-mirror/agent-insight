# coding: utf-8
# Copyright (c) Huawei Technologies Co., Ltd. 2026. All rights reserved.
"""Unit tests for AgentRASRail in-flight monitor cache (CR-003)."""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from core.config import AgentRASConfig
from core.monitor import AgentRASMonitor
from recovery.engine import RecoveryExecutor, RecoveryPolicy
from platform_adapter.openjiuwen.rail import AgentRASRail


def _ctx_for_session(session_id: str) -> SimpleNamespace:
    return SimpleNamespace(
        session=SimpleNamespace(get_session_id=lambda: session_id),
        inputs=None,
        agent=None,
    )


def _make_monitor(session_id: str) -> AgentRASMonitor:
    return AgentRASMonitor(
        detectors=[],
        reporter=None,
        policy=RecoveryPolicy(),
        agents=None,
        config=AgentRASConfig(),
        executor=RecoveryExecutor(None),
        member_name="m",
        session_id=session_id,
    )


def test_monitor_cache_does_not_evict_when_over_soft_limit(caplog) -> None:
    """33 in-flight sessions must all remain; soft-limit warning only (CR-003)."""
    import logging

    created: list[str] = []

    def monitor_factory(session_id: str) -> AgentRASMonitor:
        created.append(session_id)
        return _make_monitor(session_id)

    rail = AgentRASRail(
        monitor_factory=monitor_factory,
        member_name="m",
        config=AgentRASConfig(),
    )
    assert rail._monitor_soft_limit == 32

    session_ids = [f"sess-{i:02d}" for i in range(33)]
    with caplog.at_level(logging.WARNING):
        for sid in session_ids:
            rail._monitor_for(_ctx_for_session(sid))

    assert len(rail._monitors) == 33
    assert set(rail._monitors.keys()) == set(session_ids)
    assert rail._monitors["sess-00"] is not None
    assert len(created) == 33
    assert any(
        "exceeds soft limit" in r.message and "not evicted" in r.message
        for r in caplog.records
    )
