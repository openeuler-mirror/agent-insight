"""Filesystem loaders for SkillBench analysis artifacts."""

from __future__ import annotations

import json
from collections import defaultdict
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from .config import REQUIRED_GROUPS
from .metrics import duration_from_result, extract_token_counts, safe_float
from .models import Trial, TrialArtifact, TrialRecord


def load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ValueError(f"Expected JSON object in {path}")
    return data


def extract_session_id(result: dict[str, Any], task_dir: Path) -> str | None:
    trajectory_path = task_dir / "agent" / "trajectory.json"
    if trajectory_path.exists():
        try:
            trajectory = load_json(trajectory_path)
        except Exception:
            trajectory = {}
        session_id = trajectory.get("session_id")
        if isinstance(session_id, str) and session_id:
            return session_id

    task_id = result.get("task_id")
    if isinstance(task_id, str) and task_id.startswith("ses_"):
        return task_id
    return None


def _exception_type(result: dict[str, Any]) -> str | None:
    exception_info = result.get("exception_info")
    if not isinstance(exception_info, dict):
        return None
    exception_type = exception_info.get("exception_type")
    return exception_type if isinstance(exception_type, str) else None


def _reward(result: dict[str, Any]) -> float | None:
    verifier_result = result.get("verifier_result") or {}
    rewards = verifier_result.get("rewards") if isinstance(verifier_result, dict) else {}
    rewards = rewards if isinstance(rewards, dict) else {}
    return safe_float(rewards.get("reward"))


def _agent_result(result: dict[str, Any]) -> dict[str, Any]:
    agent_result = result.get("agent_result") or {}
    return agent_result if isinstance(agent_result, dict) else {}


def _task_name(result: dict[str, Any], task_dir: Path, *, split_fallback: bool) -> str:
    raw_name = result.get("task_name")
    if isinstance(raw_name, str) and raw_name:
        return raw_name
    return task_dir.name.split("__", 1)[0] if split_fallback else task_dir.name


def _iter_trials(
    skillbench_root: Path,
    groups: tuple[str, ...],
    *,
    drop_zero_tokens: bool,
    split_fallback: bool,
) -> Iterator[Trial]:
    allowed_groups = set(groups)
    for result_path in sorted(skillbench_root.glob("jobs_*/*/*/result.json")):
        task_dir = result_path.parent
        run_dir = task_dir.parent
        jobs_dir = run_dir.parent

        if not jobs_dir.name.startswith("jobs_"):
            continue
        group = jobs_dir.name.removeprefix("jobs_")
        if group not in allowed_groups:
            continue

        result = load_json(result_path)
        agent_result = _agent_result(result)
        input_tokens, cache_tokens, output_tokens, total_tokens = extract_token_counts(agent_result)
        if drop_zero_tokens and total_tokens <= 0:
            continue

        reward = _reward(result)
        yield Trial(
            group=group,
            task_name=_task_name(result, task_dir, split_fallback=split_fallback),
            trial_name=str(result.get("trial_name") or task_dir.name),
            run_datetime=run_dir.name,
            session_id=extract_session_id(result, task_dir),
            reward=reward,
            success=(reward or 0.0) > 0.0,
            total_tokens=total_tokens,
            input_tokens=input_tokens,
            cache_tokens=cache_tokens,
            output_tokens=output_tokens,
            cost_usd=safe_float(agent_result.get("cost_usd")),
            duration_sec=duration_from_result(result),
            exception_type=_exception_type(result),
            result_path=str(result_path),
        )


def collect_trials(
    skillbench_root: Path,
    groups: tuple[str, ...] = REQUIRED_GROUPS,
) -> list[TrialRecord]:
    return list(_iter_trials(skillbench_root, groups, drop_zero_tokens=True, split_fallback=False))


def collect_trial_artifacts(
    skillbench_root: Path,
    groups: tuple[str, ...],
) -> list[TrialArtifact]:
    return list(_iter_trials(skillbench_root, groups, drop_zero_tokens=False, split_fallback=True))


def parse_all_task_names(skillbench_root: Path, groups: tuple[str, ...]) -> list[str]:
    tasks: set[str] = set()
    allowed_groups = set(groups)
    for result_path in skillbench_root.glob("jobs_*/*/*/result.json"):
        task_dir = result_path.parent
        jobs_dir = task_dir.parent.parent
        if jobs_dir.name.removeprefix("jobs_") not in allowed_groups:
            continue
        try:
            payload = load_json(result_path)
        except Exception:
            payload = {}
        tasks.add(_task_name(payload, task_dir, split_fallback=True))
    return sorted(tasks)


def find_common_tasks_for_groups(records: list[TrialRecord], groups: list[str] | tuple[str, ...]) -> set[str]:
    if not groups:
        return set()

    tasks_by_group: dict[str, set[str]] = {group: set() for group in groups}
    for record in records:
        if record.group in tasks_by_group:
            tasks_by_group[record.group].add(record.task_name)
    return set.intersection(*(tasks_by_group[group] for group in groups))


def find_common_tasks(records: list[TrialRecord], groups: tuple[str, ...] = REQUIRED_GROUPS) -> set[str]:
    return find_common_tasks_for_groups(records, groups)


def group_records_by_task_and_group(
    records: list[TrialRecord],
    common_tasks: set[str],
) -> dict[str, dict[str, list[TrialRecord]]]:
    grouped: dict[str, dict[str, list[TrialRecord]]] = defaultdict(lambda: defaultdict(list))
    for record in records:
        if record.task_name in common_tasks:
            grouped[record.task_name][record.group].append(record)
    return grouped
