"""Serialize / filter FaultDefinition.injection_runtime for Adapter env transport.

This is thin glue around catalog definitions — not a planning domain and not
part of injection capabilities.
"""

from __future__ import annotations

import json
from typing import Any

from ..catalog.models import InjectionStep
from ..catalog.scenarios import normalize_submode


def filter_runtime_steps_for_submode(
    steps: tuple[InjectionStep, ...] | list[InjectionStep],
    submode: str | None,
) -> tuple[InjectionStep, ...]:
    """Drop runtime steps whose when_submode does not match the active submode."""

    active = normalize_submode(submode) or "1"
    selected: list[InjectionStep] = []
    for step in steps:
        if step.when_submode is None:
            selected.append(step)
            continue
        if normalize_submode(step.when_submode) == active:
            selected.append(step)
    return tuple(selected)


def runtime_plan_to_json(steps: tuple[InjectionStep, ...] | list[InjectionStep]) -> str:
    payload: list[dict[str, Any]] = []
    for step in steps:
        item: dict[str, Any] = {"op": step.op, "args": step.arg_map()}
        if step.when:
            item["when"] = dict(step.when)
        if step.when_submode is not None:
            item["when_submode"] = step.when_submode
        payload.append(item)
    return json.dumps(payload, ensure_ascii=False)


def parse_runtime_plan_json(raw: str | None) -> list[dict[str, Any]]:
    if not raw or not raw.strip():
        return []
    value = json.loads(raw)
    if not isinstance(value, list):
        raise ValueError("AGENT_FI_INJECTION_RUNTIME must be a JSON array")
    return [item for item in value if isinstance(item, dict)]


def plan_as_dicts(
    plan: list[dict[str, Any]] | tuple[InjectionStep, ...],
) -> list[dict[str, Any]]:
    """Normalize typed InjectionStep tuples or raw dict plans to dict steps."""

    if plan and isinstance(plan[0], InjectionStep):
        return json.loads(runtime_plan_to_json(plan))  # type: ignore[arg-type]
    return list(plan)  # type: ignore[arg-type]
