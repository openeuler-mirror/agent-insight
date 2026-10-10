"""Models for reusable behavioral faults and UI presentation."""

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
    expose_skill_to_agent: bool = True


@dataclass(frozen=True, slots=True)
class FaultUiSubmode:
    name: str
    id: str | None = None
    description: str = ""
    visible: bool = True

    def as_dict(self) -> dict[str, str]:
        return {
            "id": self.id or "",
            "name": self.name,
            "description": self.description,
        }


@dataclass(frozen=True, slots=True)
class FaultUiEntry:
    id: str
    label_zh: str | None = None
    label_en: str | None = None
    visible: bool = True
    order: int | None = None
    submodes: tuple[FaultUiSubmode, ...] | None = None
    platforms: tuple[str, ...] | None = None


@dataclass(frozen=True, slots=True)
class FaultUiCatalog:
    injection_methods: dict[str, str]
    faults: tuple[FaultUiEntry, ...]

    def entry(self, fault_id: str) -> FaultUiEntry | None:
        for item in self.faults:
            if item.id == fault_id:
                return item
        return None

    def ordered_ids(self, discovered: list[str]) -> list[str]:
        """Return discovered ids ordered by metadata.order, then remaining sorted."""
        discovered_set = set(discovered)
        entries = [item for item in self.faults if item.id in discovered_set]
        with_order = sorted(
            (item for item in entries if item.order is not None),
            key=lambda item: (item.order if item.order is not None else 0, item.id),
        )
        without_order = sorted(
            item.id for item in entries if item.order is None
        )
        ordered = [item.id for item in with_order] + without_order
        known = {item.id for item in self.faults}
        remaining = sorted(name for name in discovered if name not in known)
        return ordered + remaining
