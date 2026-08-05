"""Injection execution context."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..installer import InstallSession


@dataclass(slots=True)
class InjectionContext:
    """Runtime context for applying a structural injection plan."""

    workspace: Path
    artifacts_dir: Path
    events_file: Path
    installation: InstallSession
    submode: str | None = None
    assets_root: Path | None = None
    snapshots: dict[str, dict[str, Any]] = field(default_factory=dict)
    last_ops: list[dict[str, Any]] = field(default_factory=list)

    def resolve_workspace_path(self, relative: str) -> Path:
        path = Path(relative)
        if path.is_absolute():
            raise ValueError(f"Injection path must be relative: {relative}")
        if ".." in path.parts:
            raise ValueError(f"Injection path must not contain '..': {relative}")
        return (self.workspace / path).resolve()

    def resolve_asset(self, name: str) -> Path:
        if self.assets_root is None:
            raise FileNotFoundError("Fault has no assets/ directory")
        asset = self.assets_root / name
        if not asset.is_file():
            raise FileNotFoundError(f"Injection asset not found: {asset}")
        return asset
