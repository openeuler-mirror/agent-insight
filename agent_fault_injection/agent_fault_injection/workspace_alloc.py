"""Allocate an isolated per-run workspace under a user-provided base directory."""

from __future__ import annotations

import shutil
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

_PACKAGE_ROOT = Path(__file__).resolve().parents[2]
_SUGGESTED_DEFAULT_WORKSPACE = Path("/tmp/ras-workspace")


class WorkspaceAllocationError(ValueError):
    """Raised when a base workspace cannot be used for allocation."""


def package_root() -> Path:
    """Return the agent-fault-injection repository / package root."""

    return _PACKAGE_ROOT


def is_eval_package_root(path: Path | str) -> bool:
    """True when ``path`` is the agent-fault-injection source tree root."""

    resolved = Path(path).expanduser().resolve()
    if resolved == _PACKAGE_ROOT:
        return True
    pyproject = resolved / "pyproject.toml"
    if not pyproject.is_file():
        return False
    try:
        text = pyproject.read_text(encoding="utf-8")
    except OSError:
        return False
    return 'name = "agent-fault-injection"' in text or "name = 'agent-fault-injection'" in text


def suggested_default_workspace(*, ensure_exists: bool = False) -> Path:
    """Prefer cwd unless it is the package root; then use ``/tmp/ras-workspace``."""

    cwd = Path.cwd().resolve()
    if is_eval_package_root(cwd):
        if ensure_exists:
            _SUGGESTED_DEFAULT_WORKSPACE.mkdir(parents=True, exist_ok=True)
        return _SUGGESTED_DEFAULT_WORKSPACE.resolve()
    return cwd


def assert_safe_base_workspace(base: Path | str) -> Path:
    """Resolve ``base`` and refuse the eval package root."""

    base_path = Path(base).expanduser().resolve()
    if not base_path.is_dir():
        raise WorkspaceAllocationError(f"Workspace does not exist: {base_path}")
    if is_eval_package_root(base_path):
        raise WorkspaceAllocationError(
            "Refusing to use the agent-fault-injection package root as workspace base: "
            f"{base_path}. Use an isolated directory such as /tmp/ras-workspace."
        )
    return base_path


def sanitize_path_component(value: str, *, fallback: str = "item") -> str:
    """Make a string safe for use as a single path component."""

    cleaned = "".join(
        char if char.isalnum() or char in "-_" else "-" for char in value.strip()
    )
    return cleaned or fallback


def new_run_id() -> str:
    """Generate a run id matching ArtifactStore naming."""

    timestamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    return f"ras-{timestamp}-{uuid4().hex[:8]}"


def allocate_run_workspace(
    base: Path | str,
    scope: str,
    fault: str,
    run_id: str,
) -> Path:
    """Create ``{base}/.ras-runs/{scope}/{safe_fault}-{run_id}/``.

    If ``base/README.md`` exists it is copied into the new directory (seed).
    """

    base_path = assert_safe_base_workspace(base)

    safe_scope = sanitize_path_component(scope, fallback="single")
    safe_fault = sanitize_path_component(fault, fallback="fault")
    safe_run = sanitize_path_component(run_id, fallback="run")
    destination = base_path / ".ras-runs" / safe_scope / f"{safe_fault}-{safe_run}"
    destination.mkdir(parents=True, exist_ok=False)

    readme = base_path / "README.md"
    if readme.is_file():
        shutil.copy2(readme, destination / "README.md")
    return destination


def allocated_workspace_path(workspace: Path | str) -> Path | None:
    """Return the path if it is a leaf under ``.ras-runs/<scope>/``, else None."""

    resolved = Path(workspace).expanduser().resolve()
    parts = resolved.parts
    try:
        index = parts.index(".ras-runs")
    except ValueError:
        return None
    # Expect .ras-runs / scope / leaf (at least two components after .ras-runs).
    if len(parts) < index + 3:
        return None
    if not resolved.is_dir():
        return None
    return resolved


def remove_allocated_workspace(workspace: Path | str) -> bool:
    """Delete an allocated ``.ras-runs/...`` leaf directory. Never deletes base."""

    target = allocated_workspace_path(workspace)
    if target is None:
        return False
    shutil.rmtree(target)
    return True
