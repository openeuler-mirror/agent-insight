"""Registry of structural injection ops (Command + Registry pattern)."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from .context import InjectionContext

InjectionOp = Callable[[InjectionContext, dict[str, Any]], dict[str, Any]]

_REGISTRY: dict[str, InjectionOp] = {}


def register(op_name: str, func: InjectionOp) -> InjectionOp:
    """Register a structural op implementation under its fault.json op id."""

    _REGISTRY[op_name] = func
    return func


def get_op(op_name: str) -> InjectionOp:
    try:
        return _REGISTRY[op_name]
    except KeyError as exc:
        raise KeyError(f"Unknown injection op: {op_name}") from exc
