"""Build Insight-ingest payload from run artifacts (no local judge)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .evaluation import (
    load_runtime_injection_evidence,
    load_structural_injection_evidence,
)
from .models import RunArtifacts


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
    interactions: list[Any] = []
    interactions_file = artifacts.root / "interactions.json"
    if interactions_file.is_file():
        try:
            data = json.loads(interactions_file.read_text(encoding="utf-8"))
            if isinstance(data, dict) and isinstance(data.get("interactions"), list):
                interactions = data["interactions"]
                markers = markers or data.get("markers") or []
                session_id = session_id or data.get("taskId")
            elif isinstance(data, list):
                interactions = data
        except (json.JSONDecodeError, OSError):
            pass

    structural = load_structural_injection_evidence(artifacts)
    runtime = load_runtime_injection_evidence(artifacts)
    evidence: dict[str, Any] = {}
    if structural:
        evidence["structural"] = structural
    if runtime:
        evidence["runtime"] = runtime

    return {
        "runId": artifacts.run_id,
        "taskId": session_id or artifacts.run_id,
        "framework": framework,
        "fault": fault,
        "injectionMethod": injection_method or "skill_inject",
        "faultActivated": fault_activated,
        "faultActivatedAt": fault_activated_at,
        "interactions": interactions,
        "markers": markers or [],
        "injectionEvidence": evidence,
    }


def write_collect_payload(artifacts: RunArtifacts, payload: dict[str, Any]) -> Path:
    path = artifacts.root / "collect-result.json"
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return path
