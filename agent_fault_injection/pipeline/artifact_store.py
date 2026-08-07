"""Creation and atomic maintenance of experiment artifacts."""

from __future__ import annotations

import json
import os
import shutil
from dataclasses import asdict
from datetime import UTC, datetime
from enum import Enum
from pathlib import Path
from typing import Any
from uuid import uuid4

from .models import RunArtifacts, RunRequest, RunStatus


def _json_default(value: Any) -> Any:
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, Enum):
        return value.value
    raise TypeError(f"Cannot serialize {type(value).__name__}")


class ArtifactStore:
    """Owns the on-disk structure for one or more experiment runs."""

    def __init__(self, output_dir: Path) -> None:
        self.output_dir = output_dir.resolve()

    def create(self, request: RunRequest) -> RunArtifacts:
        if request.run_id:
            run_id = request.run_id
        else:
            timestamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
            run_id = f"ras-{timestamp}-{uuid4().hex[:8]}"
        root = self.output_dir / run_id
        raw_dir = root / "raw"
        resolved_fault_dir = root / "resolved_fault"
        if root.exists():
            # Same run_id retried after a partial failure — reclaim.
            shutil.rmtree(root, ignore_errors=True)
        raw_dir.mkdir(parents=True, exist_ok=False)
        resolved_fault_dir.mkdir(parents=True, exist_ok=False)

        artifacts = RunArtifacts(
            run_id=run_id,
            root=root,
            raw_dir=raw_dir,
            resolved_fault_dir=resolved_fault_dir,
            events_file=raw_dir / "events.jsonl",
            session_file=raw_dir / "session.json",
            stdout_file=raw_dir / "stdout.log",
            stderr_file=raw_dir / "stderr.log",
            trajectory_file=root / "trajectory.jsonl",
            interactions_file=root / "interactions.json",
            execution_file=root / "execution.jsonl",
            manifest_file=root / "manifest.json",
            request_file=root / "request.json",
            plugin_ready_file=raw_dir / "plugin-ready.json",
        )

        self.write_json(artifacts.request_file, asdict(request))
        self.write_manifest(
            artifacts,
            {
                "schema_version": "1",
                "run_id": run_id,
                "status": RunStatus.CREATED,
                "created_at": datetime.now(UTC).isoformat(),
                "platform": request.platform,
                "framework": request.platform,
                "agent": request.agent,
                "fault": request.fault,
                "interactions": "interactions.json",
            },
        )
        return artifacts

    def update_manifest(self, artifacts: RunArtifacts, **updates: Any) -> None:
        current: dict[str, Any] = {}
        if artifacts.manifest_file.exists():
            current = json.loads(artifacts.manifest_file.read_text(encoding="utf-8"))
        current.update(updates)
        current["updated_at"] = datetime.now(UTC).isoformat()
        self.write_manifest(artifacts, current)

    def write_manifest(self, artifacts: RunArtifacts, value: dict[str, Any]) -> None:
        self.write_json(artifacts.manifest_file, value)

    @staticmethod
    def write_json(path: Path, value: Any) -> None:
        content = json.dumps(
            value,
            ensure_ascii=False,
            indent=2,
            default=_json_default,
        )
        temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        temporary.write_text(content + "\n", encoding="utf-8")
        temporary.replace(path)

