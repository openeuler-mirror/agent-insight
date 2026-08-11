# coding: utf-8
# Copyright (c) Huawei Technologies Co., Ltd. 2026. All rights reserved.
"""Agent RAS composition helpers for the single-Agent in-process path.

``build_agent_ras_rail`` installs a ``monitor_factory`` so each invoke gets an
``AgentRASMonitor`` keyed by session id (detectors + executor state). The rail
drops that monitor in ``after_invoke``; HITL resume state stays on session.state.
"""
from __future__ import annotations

from typing import Any, Callable, Optional

from openjiuwen.core.foundation.llm.model import Model

from agents.base import AgentAdapter, NoOpAgentAdapter
from platform_adapter.openjiuwen.deep_agent_adapter import (
    DeepAgentAdapter,
    adapter_config_from_agent_ras,
)
from agents.ras_agents import RASAgents
from core.config import AgentRASConfig
from detectors.base import Detector
from detectors.registry import (
    build_member_detectors,
)
from core.monitor import AgentRASMonitor
from platform_adapter.openjiuwen.rail import AgentRASRail
from recovery.engine import (
    LocalAutoRecovery,
    RecoveryExecutor,
    RecoveryPolicy,
)
from core.reporter import AnomalyReporter

# Re-export for callers that imported builders from this module.
__all__ = [
    "build_member_detectors",
    "build_agent_adapter",
    "build_agent_ras_components",
    "build_agent_ras_rail",
]


def build_agent_adapter(
    config: AgentRASConfig,
    invoke_fn: Optional[Any] = None,
    model: Optional[Model] = None,
) -> AgentAdapter:
    """Build the default semantic AgentAdapter."""
    adapter_cfg = adapter_config_from_agent_ras(config)
    if invoke_fn is not None:
        return DeepAgentAdapter(cfg=adapter_cfg, invoke_fn=invoke_fn)
    if model is not None:
        return DeepAgentAdapter(cfg=adapter_cfg, model=model)
    return NoOpAgentAdapter()


def _build_policy(config: AgentRASConfig) -> RecoveryPolicy:
    return RecoveryPolicy.from_config(config.policy)


def build_agent_ras_components(
    config: AgentRASConfig,
    agents: RASAgents | None = None,
    invoke_fn: Optional[Any] = None,
    model: Optional[Model] = None,
    *,
    reporter: AnomalyReporter | None = None,
) -> tuple[
    list[Detector],
    AnomalyReporter | None,
    RecoveryPolicy,
    LocalAutoRecovery,
    RecoveryExecutor,
]:
    """Assemble detectors, policy, auto-recovery, and executor for one Monitor.

    Single-Agent path leaves ``reporter`` as None unless a host injects a sink.
    """
    if agents is None:
        adapter = build_agent_adapter(config, invoke_fn=invoke_fn, model=model)
        agents = RASAgents(adapter)
    policy = _build_policy(config)
    detectors = build_member_detectors(config, agents=agents)
    auto = LocalAutoRecovery(policy)
    executor = RecoveryExecutor(
        auto,
        notify_user_on_warning=config.recovery.notify_user_on_warning,
    )
    return detectors, reporter, policy, auto, executor


def build_agent_ras_rail(
    config: AgentRASConfig,
    member_name: str,
    invoke_fn: Optional[Any] = None,
    model: Optional[Model] = None,
    *,
    session_id: str = "",
    agents: RASAgents | None = None,
    reporter: AnomalyReporter | None = None,
    reporter_factory: Callable[[str], AnomalyReporter | None] | None = None,
) -> AgentRASRail:
    """Build an ``AgentRASRail`` with an invoke-scoped Monitor factory.

    Each active session id gets an isolated suppress/recovery executor for that
    invoke; the rail drops the monitor in ``after_invoke``. The shared
    ``RASAgents`` instance is injected into every Monitor so L3 detection and
    the recovery Reviewer reuse the same skill members. Message language
    follows DeepAgent at runtime (see ``AgentRASRail.init``).

    Optional ``reporter`` / ``reporter_factory`` let hosts inject a per-session
    anomaly sink without duplicating recovery wiring. ``reporter_factory`` wins
    when provided; it receives the runtime session id.
    When neither is provided, defaults to Insight RAS ingest via
    ``InsightAnomalyReporter`` (fail-open if Insight is not configured).
    Optional ``agents`` reuses a shared ``RASAgents`` instance across sessions.
    """
    if agents is None:
        adapter = build_agent_adapter(config, invoke_fn=invoke_fn, model=model)
        agents = RASAgents(adapter)

    def _default_reporter(runtime_session_id: str):
        from platform_adapter.common.insight_anomaly_reporter import (
            default_insight_reporter_factory,
        )

        return default_insight_reporter_factory(
            runtime_session_id or session_id,
            platform="openjiuwen",
        )

    effective_factory = reporter_factory
    if effective_factory is None and reporter is None:
        effective_factory = _default_reporter

    def monitor_factory(runtime_session_id: str) -> AgentRASMonitor:
        """Construct detectors, policy, and executor for one session id."""
        sink = (
            effective_factory(runtime_session_id or session_id)
            if effective_factory is not None
            else reporter
        )
        detectors, bound_reporter, policy, _auto, executor = build_agent_ras_components(
            config=config,
            agents=agents,
            invoke_fn=invoke_fn,
            model=model,
            reporter=sink,
        )
        return AgentRASMonitor(
            detectors=detectors,
            reporter=bound_reporter,
            policy=policy,
            agent_id=member_name,
            session_id=runtime_session_id or session_id,
            agents=agents,
            config=config,
            executor=executor,
            member_name=member_name,
        )

    return AgentRASRail(
        monitor_factory=monitor_factory,
        member_name=member_name,
        agents=agents,
        config=config,
    )
