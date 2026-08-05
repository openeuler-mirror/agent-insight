"""Shared framework-side structural injection primitives."""

from __future__ import annotations

from .apply import apply_injection_plan
from .context import InjectionContext

__all__ = ["InjectionContext", "apply_injection_plan"]
