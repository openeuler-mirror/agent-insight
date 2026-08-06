"""Map xiaoO hook/CLI events into trajectory + execution.jsonl."""

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
    fault_started: bool
    fault_activated: bool
    session_idle: bool
    session_error: bool
    event_count: int


def _read_json_lines(path: Path) -> Iterator[dict[str, Any]]:
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
                    f"Invalid xiaoO event JSON at line {line_number}: {exc}"
                ) from exc
            if not isinstance(value, dict):
                raise MappingError(
                    f"xiaoO event at line {line_number} is not an object"
                )
            yield value


class XiaoOTrajectoryMapper:
    def inspect(self, path: Path) -> CaptureSummary:
        session_id: str | None = None
        fault_started = False
        fault_activated = False
        session_idle = False
        session_error = False
        event_count = 0

        for event in _read_json_lines(path):
            event_count += 1
            kind = event.get("kind")
            payload = event.get("payload")
            if isinstance(payload, dict):
                for key in ("session_id", "sessionID"):
                    value = payload.get(key)
                    if isinstance(value, str) and value:
                        session_id = value
            if kind == "fault.activation.started":
                fault_started = True
            elif kind == "fault.activation.completed":
                fault_activated = True
            elif kind == "xiaoo.cli" and isinstance(payload, dict):
                if payload.get("type") == "error":
                    session_error = True
                if payload.get("type") == "response":
                    session_idle = True
                data = payload.get("data")
                if isinstance(data, dict):
                    sid = data.get("session_id")
                    if isinstance(sid, str) and sid:
                        session_id = sid

        return CaptureSummary(
            session_id=session_id,
            fault_started=fault_started,
            fault_activated=fault_activated,
            session_idle=session_idle,
            session_error=session_error,
            event_count=event_count,
        )

    def map(
        self,
        request: RunRequest,
        fault: FaultDefinition,
        artifacts: RunArtifacts,
    ) -> CaptureSummary:
        events = list(_read_json_lines(artifacts.events_file))
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
            payload = event.get("payload")
            session_id = None
            if isinstance(payload, dict):
                session_id = payload.get("session_id") or payload.get("sessionID")
            normalized.append(
                {
                    "schema_version": "1",
                    "event_id": f"{artifacts.run_id}:{sequence}",
                    "run_id": artifacts.run_id,
                    "platform": "xiaoo",
                    "agent": request.agent,
                    "fault": {
                        "name": fault.name,
                        "skill": fault.skill_name,
                    },
                    "phase": phase,
                    "sequence": sequence,
                    "timestamp": event.get("recorded_at"),
                    "kind": kind,
                    "session_id": session_id,
                    "payload": payload,
                }
            )

        with artifacts.trajectory_file.open("w", encoding="utf-8") as stream:
            for event in normalized:
                stream.write(json.dumps(event, ensure_ascii=False) + "\n")

        self._write_execution_file(artifacts, events)
        return summary

    def _write_execution_file(
        self,
        artifacts: RunArtifacts,
        events: list[dict[str, Any]],
    ) -> None:
        rows: list[dict[str, Any]] = []
        sequence = 0

        for event in events:
            kind = event.get("kind")
            payload = event.get("payload")
            timestamp = event.get("recorded_at")
            if kind == "xiaoo.event" and isinstance(payload, dict):
                if payload.get("type") == "tool.post":
                    tool = payload.get("tool")
                    if not isinstance(tool, str) or tool in {"skill", "builtin_skill"}:
                        continue
                    outcome = payload.get("outcome")
                    outcome = outcome if isinstance(outcome, dict) else {}
                    sequence += 1
                    rows.append(
                        {
                            "sequence": sequence,
                            "timestamp": timestamp,
                            "type": "tool",
                            "tool": tool,
                            "arguments": payload.get("input"),
                            "status": outcome.get("type"),
                            "output": outcome.get("output")
                            if outcome.get("type") == "success"
                            else outcome.get("message"),
                        }
                    )
            elif kind == "xiaoo.cli" and isinstance(payload, dict):
                if payload.get("type") == "response":
                    data = payload.get("data")
                    data = data if isinstance(data, dict) else {}
                    text = data.get("raw_reply")
                    if isinstance(text, str) and text:
                        sequence += 1
                        rows.append(
                            {
                                "sequence": sequence,
                                "timestamp": timestamp,
                                "type": "assistant",
                                "content": text,
                            }
                        )
                        sequence += 1
                        rows.append(
                            {
                                "sequence": sequence,
                                "timestamp": timestamp,
                                "type": "final_answer",
                                "content": text,
                            }
                        )
                elif payload.get("type") == "error":
                    data = payload.get("data")
                    data = data if isinstance(data, dict) else {}
                    message = data.get("message")
                    if isinstance(message, str) and message:
                        sequence += 1
                        rows.append(
                            {
                                "sequence": sequence,
                                "timestamp": timestamp,
                                "type": "session_error",
                                "message": message,
                            }
                        )

        # Also parse stdout NDJSON if present (CLI --format json).
        if artifacts.stdout_file.is_file():
            for line in artifacts.stdout_file.read_text(
                encoding="utf-8",
                errors="replace",
            ).splitlines():
                stripped = line.strip()
                if not stripped.startswith("{"):
                    continue
                try:
                    row = json.loads(stripped)
                except json.JSONDecodeError:
                    continue
                if not isinstance(row, dict):
                    continue
                if row.get("type") != "response":
                    continue
                data = row.get("data")
                if not isinstance(data, dict):
                    continue
                text = data.get("raw_reply")
                if not isinstance(text, str) or not text:
                    continue
                # Avoid duplicate final_answer if already recorded from events.
                if any(
                    item.get("type") == "final_answer"
                    and item.get("content") == text
                    for item in rows
                ):
                    continue
                sequence += 1
                rows.append(
                    {
                        "sequence": sequence,
                        "timestamp": None,
                        "type": "assistant",
                        "content": text,
                    }
                )
                sequence += 1
                rows.append(
                    {
                        "sequence": sequence,
                        "timestamp": None,
                        "type": "final_answer",
                        "content": text,
                    }
                )

        with artifacts.execution_file.open("w", encoding="utf-8") as stream:
            for row in rows:
                stream.write(json.dumps(row, ensure_ascii=False) + "\n")
