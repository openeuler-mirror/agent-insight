"""Core experiment models shared by the CLI, runner, and adapters."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Any


class RunStatus(StrEnum):
    CREATED = "created"
    PREPARING = "preparing"
    PLATFORM_STARTING = "platform_starting"
    PLUGIN_READY = "plugin_ready"
    AGENT_RUNNING = "agent_running"
    MAPPING = "mapping"
    COMPLETED = "completed"
    FAILED = "failed"


class FaultOutcome(StrEnum):
    """Dimension 1: whether the injected fault behavior occurred."""

    OCCURRED = "occurred"
    NOT_OCCURRED = "not_occurred"


class FaultContainmentStatus(StrEnum):
    """Dimension 2: recovery/prevention handling around the fault."""

    UNRESOLVED = "unresolved"
    RECOVERED = "recovered"
    PREVENTED = "prevented"
    INCONCLUSIVE = "inconclusive"


class TerminationReason(StrEnum):
    SESSION_IDLE = "session_idle"
    SESSION_ERROR = "session_error"
    PROCESS_EXITED = "process_exited"
    TIMEOUT = "timeout"
    USER_INTERRUPT = "user_interrupt"
    PLUGIN_START_FAILED = "plugin_start_failed"
    FAULT_NOT_ACTIVATED = "fault_not_activated"
    PLATFORM_ERROR = "platform_error"


@dataclass(frozen=True, slots=True)
class RunRequest:
    """A fully resolved experiment request."""

    platform: str
    agent: str
    fault: str
    prompt: str
    workspace: Path
    output_dir: Path
    timeout_seconds: int = 600
    platform_options: dict[str, Any] = field(default_factory=dict)
    submode: str | None = None
    run_id: str | None = None

    def __post_init__(self) -> None:
        if not self.platform.strip():
            raise ValueError("platform must not be empty")
        if not self.agent.strip():
            raise ValueError("agent must not be empty")
        if not self.fault.strip():
            raise ValueError("fault must not be empty")
        if not self.prompt.strip():
            raise ValueError("prompt must not be empty")
        if self.timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be greater than zero")


@dataclass(frozen=True, slots=True)
class RunArtifacts:
    """Paths belonging to a single experiment run."""

    run_id: str
    root: Path
    raw_dir: Path
    resolved_fault_dir: Path
    events_file: Path
    session_file: Path
    stdout_file: Path
    stderr_file: Path
    trajectory_file: Path
    interactions_file: Path
    execution_file: Path
    manifest_file: Path
    request_file: Path
    plugin_ready_file: Path


@dataclass(frozen=True, slots=True)
class PlatformRunResult:
    """Raw result returned by a platform adapter."""

    exit_code: int
    termination_reason: TerminationReason
    session_id: str | None = None
    fault_activated: bool = False


@dataclass(frozen=True, slots=True)
class FaultEvaluation:
    """Structured decision returned by the isolated judge agent."""

    outcome: FaultOutcome
    fault_containment_status: FaultContainmentStatus
    reason: str
    raw_response: str | None = None


@dataclass(frozen=True, slots=True)
class RunResult:
    """Final result returned to CLI callers."""

    run_id: str
    status: RunStatus
    termination_reason: TerminationReason
    artifacts: RunArtifacts
    exit_code: int
    error: str | None = None
    fault_outcome: FaultOutcome | None = None
    fault_reason: str | None = None
    evaluation_error: str | None = None
    fault_containment_status: FaultContainmentStatus | None = None
