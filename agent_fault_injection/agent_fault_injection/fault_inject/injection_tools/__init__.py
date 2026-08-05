"""Fine-grained fault injection capabilities (file ops + runtime rewrites).

Plans live in catalog/fault.json (FaultDefinition). Env serialization and
plan application live in fault_inject.runtime_env / apply_plan. This package
only performs side effects and returns structured results — it does not write
judge evidence snapshots.
"""

from __future__ import annotations

from .context import InjectionContext
from .rewrite_engine import (
    apply_assistant_text_rewrite,
    apply_messages_rewrite,
    apply_system_rewrite,
    apply_tool_result_rewrite,
)

__all__ = [
    "InjectionContext",
    "apply_assistant_text_rewrite",
    "apply_messages_rewrite",
    "apply_system_rewrite",
    "apply_tool_result_rewrite",
]
