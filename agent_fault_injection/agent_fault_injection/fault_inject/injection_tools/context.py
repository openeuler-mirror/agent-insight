"""Sandbox handles for file-op capabilities (workspace + installer)."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..installer import InstallSession


@dataclass(slots=True)
class InjectionContext:
    """Sandbox + artifact handles for applying a structural injection plan."""

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
        workspace = self.workspace.resolve()
        target = (workspace / path).resolve()
        if not target.is_relative_to(workspace):
            raise ValueError(f"Injection path escapes workspace: {relative}")
        return target

    def resolve_asset(self, name: str) -> Path:
        if self.assets_root is None:
            raise FileNotFoundError("Fault has no assets/ directory")
        asset_path = Path(name)
        if asset_path.is_absolute():
            raise ValueError(f"Injection asset must be relative: {name}")
        if ".." in asset_path.parts:
            raise ValueError(f"Injection asset must not contain '..': {name}")
        root = self.assets_root.resolve()
        asset = (root / asset_path).resolve()
        if not asset.is_relative_to(root):
            raise ValueError(f"Injection asset escapes assets/: {name}")
        if not asset.is_file():
            raise FileNotFoundError(f"Injection asset not found: {asset}")
        return asset
