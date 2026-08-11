"""Build Insight-ingest payload from run artifacts."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .models import RunArtifacts
from .session_ids import resolve_platform_session_id


def events_indicate_fault_activated(artifacts: RunArtifacts) -> bool:
    """True when events.jsonl contains fault.activation.completed."""

    path = artifacts.events_file
    if not path.is_file():
        return False
    try:
        with path.open("r", encoding="utf-8") as stream:
            for line in stream:
                if not line.strip():
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(event, dict) and event.get("kind") == (
                    "fault.activation.completed"
                ):
                    return True
    except OSError:
        return False
    return False


def build_collect_payload(
    artifacts: RunArtifacts,
    *,
    framework: str,
    fault: str,
    injection_method: str | None = None,
    fault_activated: bool = False,
    fault_activated_at: int | None = None,
    session_id: str | None = None,
    markers: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    interactions_task_id: str | None = None
    interactions_file = artifacts.root / "interactions.json"
    if interactions_file.is_file():
        try:
            data = json.loads(interactions_file.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                markers = markers or data.get("markers") or []
                raw_tid = data.get("taskId")
                if isinstance(raw_tid, str):
                    interactions_task_id = raw_tid
        except (json.JSONDecodeError, OSError):
            pass

    platform_session_id, session_aligned = resolve_platform_session_id(
        interactions_task_id=interactions_task_id,
        platform_session_id=session_id,
    )

    activated = bool(fault_activated) or events_indicate_fault_activated(artifacts)

    return {
        "runId": artifacts.run_id,
        # Trace ID: bare platform session only. Never silently use runId.
        "taskId": platform_session_id,
        "sessionAligned": session_aligned,
        "framework": framework,
        "fault": fault,
        "injectionMethod": injection_method or "skill_inject",
        "faultActivated": activated,
        "faultActivatedAt": fault_activated_at,
        "interactions": [],
        "markers": markers or [],
    }


def write_collect_payload(artifacts: RunArtifacts, payload: dict[str, Any]) -> Path:
    path = artifacts.root / "collect-result.json"
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return path
