"""Apply fault.json injection plans using shared primitives."""

from __future__ import annotations

from ..models import FaultDefinition
from . import file_ops as _file_ops  # noqa: F401 — register builtins
from .context import InjectionContext
from .registry import get_op


def _normalize_submode(value: str | None) -> str | None:
    if value is None:
        return None
    text = value.strip()
    if not text:
        return None
    # Accept "1", "场景1", "case1" style by extracting trailing digits when present.
    digits = "".join(ch for ch in text if ch.isdigit())
    if digits:
        return digits.lstrip("0") or "0"
    return text


def _step_matches(when_submode: str | None, current: str | None) -> bool:
    if when_submode is None:
        return True
    wanted = _normalize_submode(when_submode)
    actual = _normalize_submode(current) or "1"
    return wanted == actual


def apply_injection_plan(
    fault: FaultDefinition,
    ctx: InjectionContext,
) -> list[dict]:
    """Run the fault's structural injection plan; no-op when empty."""

    if not fault.injection_plan:
        return []

    if ctx.assets_root is None and fault.assets_dir is not None:
        ctx.assets_root = fault.assets_dir

    results: list[dict] = []
    for step in fault.injection_plan:
        if not _step_matches(step.when_submode, ctx.submode):
            continue
        op = get_op(step.op)
        result = op(ctx, step.arg_map())
        ctx.last_ops.append(result)
        results.append(result)
    return results
