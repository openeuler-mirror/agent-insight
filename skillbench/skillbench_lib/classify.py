"""Status classification helpers for SkillBench trial records."""

from __future__ import annotations

from statistics import mean

from .config import (
    ENV_TIMEOUT_EXCEPTIONS,
    SETUP_TIMEOUT_EXCEPTIONS,
    STATUS_AGENT_TIMEOUT,
    STATUS_ENV_TIMEOUT,
    STATUS_FAIL,
    STATUS_MISSING,
    STATUS_PARTIAL,
    STATUS_SETUP_TIMEOUT,
    STATUS_SUCCESS,
    TIMEOUT_HIGH,
    TIMEOUT_LOW,
)
from .models import CellState, TrialArtifact, TrialRecord


def is_timeout_duration(duration_sec: float | None) -> bool:
    return duration_sec is not None and TIMEOUT_LOW <= duration_sec <= TIMEOUT_HIGH


def is_agent_timeout_record(record: TrialArtifact | TrialRecord) -> bool:
    return record.exception_type == "AgentTimeoutError" or (
        record.exception_type is None and is_timeout_duration(record.duration_sec)
    )


def has_agent_timeout(records: list[TrialArtifact] | list[TrialRecord]) -> bool:
    return any(is_agent_timeout_record(record) for record in records)


def classify_cell(records: list[TrialArtifact]) -> CellState:
    if not records:
        return CellState(STATUS_MISSING, None, None, None, None, None, 0)

    valid_records = [record for record in records if record.total_tokens > 0]

    any_agent_timeout = has_agent_timeout(records)
    any_setup_timeout = any(record.exception_type in SETUP_TIMEOUT_EXCEPTIONS for record in records)
    any_env_timeout = any(record.exception_type in ENV_TIMEOUT_EXCEPTIONS for record in records)

    if not valid_records:
        if any_agent_timeout:
            return CellState(STATUS_AGENT_TIMEOUT, None, None, None, None, None, len(records))
        if any_setup_timeout:
            return CellState(STATUS_SETUP_TIMEOUT, None, None, None, None, None, len(records))
        if any_env_timeout:
            return CellState(STATUS_ENV_TIMEOUT, None, None, None, None, None, len(records))
        return CellState(STATUS_MISSING, None, None, None, None, None, len(records))

    success_rate = mean(1.0 if record.success else 0.0 for record in valid_records)
    mean_tokens = mean(record.total_tokens for record in valid_records)
    durations = [record.duration_sec for record in valid_records if record.duration_sec is not None]
    costs = [record.cost_usd for record in valid_records if record.cost_usd is not None]
    mean_duration = mean(durations) if durations else None
    mean_cost = mean(costs) if costs else None
    mean_cost_per_1M = (
        (mean_cost / mean_tokens) * 1_000_000.0
        if mean_cost is not None and mean_tokens and mean_tokens > 0
        else None
    )

    if any_agent_timeout:
        status = STATUS_AGENT_TIMEOUT
    elif any_setup_timeout:
        status = STATUS_SETUP_TIMEOUT
    elif any_env_timeout:
        status = STATUS_ENV_TIMEOUT
    elif success_rate == 1.0:
        status = STATUS_SUCCESS
    elif success_rate == 0.0:
        status = STATUS_FAIL
    else:
        status = STATUS_PARTIAL

    return CellState(
        status=status,
        success_rate=success_rate,
        mean_tokens=mean_tokens,
        mean_duration=mean_duration,
        mean_cost=mean_cost,
        mean_cost_per_1M=mean_cost_per_1M,
        n_trials=len(valid_records),
    )
