"""Mapping from OpenCode plugin events to the common trajectory format."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

from ...pipeline.exceptions import MappingError
from ...fault_inject.catalog.models import FaultDefinition
from ...pipeline.models import RunArtifacts, RunRequest


@dataclass(frozen=True, slots=True)
class CaptureSummary:
    session_id: str | None
    fault_activated: bool
    event_count: int


def _session_id(payload: Any) -> str | None:
    """Extract OpenCode session id from current FI plugin payload shape."""

    if not isinstance(payload, dict):
        return None
    for key in ("sessionID", "session_id"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


class OpenCodeTrajectoryMapper:
    """Converts append-only plugin records without discarding raw payloads."""

    def read_events(self, path: Path) -> Iterator[dict[str, Any]]:
        if not path.exists():
            return

        with path.open("r", encoding="utf-8") as stream:
            for line_number, line in enumerate(stream, start=1):
                if not line.strip():
                    continue
                try:
                    value = json.loads(line)
                except json.JSONDecodeError as exc:
                    raise MappingError(
                        f"Invalid OpenCode event JSON at line {line_number}: {exc}"
                    ) from exc
                if not isinstance(value, dict):
                    raise MappingError(
                        f"OpenCode event at line {line_number} is not an object"
                    )
                yield value

    def inspect(self, path: Path) -> CaptureSummary:
        session_id: str | None = None
        fault_activated = False
        event_count = 0

        for event in self.read_events(path):
            event_count += 1
            kind = event.get("kind")
            payload = event.get("payload")
            session_id = _session_id(payload) or session_id

            if kind == "fault.activation.completed":
                fault_activated = True

        return CaptureSummary(
            session_id=session_id,
            fault_activated=fault_activated,
            event_count=event_count,
        )

    def map(
        self,
        request: RunRequest,
        fault: FaultDefinition,
        artifacts: RunArtifacts,
    ) -> CaptureSummary:
        events = list(self.read_events(artifacts.events_file))
        summary = self.inspect(artifacts.events_file)

        phase = "bootstrap"
        normalized: list[dict[str, Any]] = []
        for event in events:
            kind = str(event.get("kind", "unknown"))
            if kind == "fault.activation.started":
                phase = "fault_activation"
            elif kind == "fault.activation.completed":
                phase = "fault_active"

            sequence = event.get("sequence")
            normalized.append(
                {
                    "schema_version": "1",
                    "event_id": f"{artifacts.run_id}:{sequence}",
                    "run_id": artifacts.run_id,
                    "platform": "opencode",
                    "agent": request.agent,
                    "fault": {
                        "name": fault.name,
                        "skill": fault.skill_name,
                    },
                    "phase": phase,
                    "sequence": sequence,
                    "timestamp": event.get("recorded_at"),
                    "kind": kind,
                    "session_id": _session_id(event.get("payload")),
                    "payload": event.get("payload"),
                }
            )

        with artifacts.trajectory_file.open("w", encoding="utf-8") as stream:
            for event in normalized:
                stream.write(json.dumps(event, ensure_ascii=False) + "\n")

        return summary
