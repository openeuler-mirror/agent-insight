"""Models for reusable behavioral faults."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True, slots=True)
class InjectionStep:
    """One framework-side structural or runtime injection operation."""

    op: str
    when_submode: str | None = None
    args: tuple[tuple[str, Any], ...] = ()
    when: tuple[tuple[str, Any], ...] = ()

    def arg_map(self) -> dict[str, Any]:
        return dict(self.args)

    def when_map(self) -> dict[str, Any]:
        return dict(self.when)


@dataclass(frozen=True, slots=True)
class FaultDefinition:
    name: str
    skill_name: str
    skill_file: Path
    description: str
    tool_files: tuple[Path, ...] = ()
    agent_tool_files: tuple[Path, ...] = ()
    authoritative_verifier_command: tuple[str, ...] | None = None
    authoritative_verifier_timeout_seconds: float = 30
    injection_method: str | None = None
    injection_plan: tuple[InjectionStep, ...] = ()
    injection_runtime: tuple[InjectionStep, ...] = ()
    assets_dir: Path | None = None
