"""Metric extraction and numeric helpers for SkillBench result payloads."""

from __future__ import annotations

from datetime import datetime
from statistics import mean
from typing import Any

from .models import TrialArtifact, TrialRecord


def safe_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def parse_timestamp(ts: str | None) -> float | None:
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def duration_from_timestamps(started_at: str | None, finished_at: str | None) -> float | None:
    start = parse_timestamp(started_at)
    finish = parse_timestamp(finished_at)
    if start is None or finish is None:
        return None
    return max(0.0, finish - start)


def duration_from_result(result: dict[str, Any]) -> float | None:
    agent_execution = result.get("agent_execution") or {}
    if not isinstance(agent_execution, dict):
        return None
    started_at = agent_execution.get("started_at")
    finished_at = agent_execution.get("finished_at")
    return duration_from_timestamps(
        started_at if isinstance(started_at, str) else None,
        finished_at if isinstance(finished_at, str) else None,
    )


def extract_token_counts(agent_result: dict[str, Any]) -> tuple[int, int, int, int]:
    input_tokens = int(agent_result.get("n_input_tokens") or 0)
    cache_tokens = int(agent_result.get("n_cache_tokens") or 0)
    output_tokens = int(agent_result.get("n_output_tokens") or 0)
    return input_tokens, cache_tokens, output_tokens, input_tokens + cache_tokens + output_tokens


def mean_or_none(values: list[float]) -> float | None:
    return mean(values) if values else None


def success_rate(records: list[TrialRecord] | list[TrialArtifact], *, scale: float = 1.0) -> float | None:
    if not records:
        return None
    return scale * sum(record.success for record in records) / len(records)
