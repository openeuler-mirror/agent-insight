"""Allocate an isolated per-run workspace under a user-provided base directory."""

from __future__ import annotations

import shutil
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

_PACKAGE_ROOT = Path(__file__).resolve().parents[2]


class WorkspaceAllocationError(ValueError):
    """Raised when a base workspace cannot be used for allocation."""


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
    if destination.exists():
        # Leftover from a failed/retried run with the same run_id — reclaim.
        shutil.rmtree(destination)
    destination.mkdir(parents=True, exist_ok=False)

    readme = base_path / "README.md"
    if readme.is_file():
        shutil.copy2(readme, destination / "README.md")
    return destination
