"""Shared prepare / AGENT_FI_* env assembly for platform adapters."""

from __future__ import annotations

import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..pipeline.artifact_store import ArtifactStore
from ..pipeline.exceptions import ToolInstallationError
from ..fault_inject.injection.apply_plan import apply_injection_plan
from ..fault_inject.injection.installer import InstallSession
from ..fault_inject.injection import InjectionContext
from ..fault_inject.catalog.models import FaultDefinition
from ..fault_inject.injection.runtime_env import (
    filter_runtime_steps_for_submode,
    runtime_plan_to_json,
)
from ..pipeline.models import RunArtifacts, RunRequest, RunStatus


@dataclass
class AdapterRunContext:
    request: RunRequest
    fault: FaultDefinition
    artifacts: RunArtifacts
    store: ArtifactStore
    workspace: Path
    installation: InstallSession = field(default_factory=InstallSession)
    isolation: Any = None


def validate_workspace(request: RunRequest) -> Path:
    workspace = request.workspace.resolve()
    if not workspace.is_dir():
        raise ValueError(
            f"Workspace does not exist or is not a directory: {workspace}"
        )
    return workspace


def copy_skill_artifact(fault: FaultDefinition, artifacts: RunArtifacts) -> None:
    shutil.copy2(
        fault.skill_file,
        artifacts.resolved_fault_dir / "SKILL.md",
    )


def apply_structural_plan(
    *,
    fault: FaultDefinition,
    artifacts: RunArtifacts,
    workspace: Path,
    installation: InstallSession,
    submode: str | None,
) -> None:
    apply_injection_plan(
        fault,
        InjectionContext(
            workspace=workspace,
            artifacts_dir=artifacts.resolved_fault_dir,
            events_file=artifacts.events_file,
            installation=installation,
            submode=submode,
            assets_root=fault.assets_dir,
        ),
    )


def assert_fault_tools_installed(*, fault: FaultDefinition, workspace: Path) -> None:
    destination_root = (
        workspace / ".agent-fault-injection" / "tools" / fault.skill_name
    )
    missing = [
        destination_root / tool_file.name
        for tool_file in fault.agent_tool_files
        if not (destination_root / tool_file.name).is_file()
    ]
    if not missing:
        return
    paths = ", ".join(str(path) for path in missing)
    raise ToolInstallationError(
        "Required fault agent tools were not present in the workspace "
        f"after install: {paths}"
    )


# RAS detector knobs — never injected or inherited via FI child env.
_RAS_DETECTOR_ENV_KEYS = frozenset(
    {
        "RAS_DETECTION_START_CHARS",
        "RAS_WINDOW_MAX_CHARS",
        "RAS_LOOP_REPEAT_THRESHOLD",
        "RAS_SEMANTIC_EVAL_CHARS",
    }
)


def strip_ras_detector_env(environment: dict[str, str]) -> dict[str, str]:
    """Drop RAS detector overrides so FI does not ferry RAS config."""

    return {
        key: value
        for key, value in environment.items()
        if key not in _RAS_DETECTOR_ENV_KEYS
    }


def build_fi_injection_env(
    *,
    artifacts: RunArtifacts,
    fault: FaultDefinition,
    submode: str | None = None,
) -> dict[str, str]:
    """FI injection-plugin env (``AGENT_FI_*``); not RAS detector or install config.

    Detection thresholds and ``AGENT_INSIGHT_RAS_HOME`` belong to RAS
    (``config.json`` / RAS-side env / Insight capability sync). Platforms may
    merge private keys (e.g. ``XIAOO_CONFIG``).
    """

    runtime_steps = filter_runtime_steps_for_submode(
        fault.injection_runtime,
        submode,
    )
    return {
        "AGENT_FI_RUN_ID": artifacts.run_id,
        "AGENT_FI_FAULT_SKILL": fault.skill_name,
        "AGENT_FI_RAW_DIR": str(artifacts.raw_dir.resolve()),
        "AGENT_FI_SCHEMA_VERSION": "1",
        "AGENT_FI_INJECTION_RUNTIME": runtime_plan_to_json(runtime_steps),
        "AGENT_FI_INJECTION_ARTIFACTS": str(
            (artifacts.resolved_fault_dir / "injection").resolve()
        ),
    }


def mark_preparing(ctx: AdapterRunContext) -> None:
    ctx.store.update_manifest(ctx.artifacts, status=RunStatus.PREPARING)
