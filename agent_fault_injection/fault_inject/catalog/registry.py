"""Discovery of built-in fault skills."""

from __future__ import annotations

import threading
from pathlib import Path

from ...pipeline.exceptions import FaultNotFoundError
from .catalog import default_skills_root, load_fault_definition
from .models import FaultDefinition

_default_registry: FaultRegistry | None = None
_default_lock = threading.Lock()


class FaultRegistry:
    def __init__(self, skills_root: Path | None = None) -> None:
        root = skills_root or default_skills_root()
        self._faults = {
            definition.name: definition
            for directory in sorted(root.iterdir())
            if directory.is_dir() and (directory / "SKILL.md").is_file()
            for definition in (load_fault_definition(directory),)
        }

    def get(self, name: str) -> FaultDefinition:
        normalized = name.strip().lower()
        try:
            fault = self._faults[normalized]
        except KeyError as exc:
            available = ", ".join(sorted(self._faults))
            raise FaultNotFoundError(
                f"Unknown fault {name!r}. Available faults: {available}"
            ) from exc

        if not fault.skill_file.is_file():
            raise FaultNotFoundError(
                f"Fault {name!r} is registered but its SKILL.md is missing"
            )
        return fault

    def names(self) -> tuple[str, ...]:
        return tuple(sorted(self._faults))


def get_fault_registry(
    *,
    skills_root: Path | None = None,
    refresh: bool = False,
) -> FaultRegistry:
    """Return the process-wide registry for the default skills root.

    Custom ``skills_root`` always constructs a fresh registry (no global cache),
    so tests and temporary catalogs stay isolated.
    """

    if skills_root is not None:
        return FaultRegistry(skills_root)

    global _default_registry
    with _default_lock:
        if refresh or _default_registry is None:
            _default_registry = FaultRegistry()
        return _default_registry


def invalidate_fault_registry() -> None:
    """Drop the cached default registry so the next get rescans disk."""

    global _default_registry
    with _default_lock:
        _default_registry = None
