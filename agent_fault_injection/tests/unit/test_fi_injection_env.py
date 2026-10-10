"""FI injection env boundary: AGENT_FI_* only; no RAS detector ferry."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

from agent_fault_injection.fault_inject.catalog.models import FaultDefinition
from agent_fault_injection.platform_adapters.lifecycle import (
    build_fi_injection_env,
    strip_ras_detector_env,
)
from agent_fault_injection.platform_adapters.opencode.adapter import OpenCodeAdapter


def test_build_fi_injection_env_keys_and_no_ras_home(tmp_path: Path) -> None:
    skill = tmp_path / "SKILL.md"
    skill.write_text("---\nname: fake\ndescription: d\n---\n", encoding="utf-8")
    fault = FaultDefinition(
        name="fake",
        skill_name="fake",
        description="d",
        skill_file=skill,
        injection_method="skill_inject",
    )
    artifacts = MagicMock()
    artifacts.run_id = "run-1"
    artifacts.raw_dir = tmp_path / "raw"
    artifacts.raw_dir.mkdir()
    artifacts.resolved_fault_dir = tmp_path / "resolved"
    artifacts.resolved_fault_dir.mkdir()
    (artifacts.resolved_fault_dir / "injection").mkdir()

    env = build_fi_injection_env(artifacts=artifacts, fault=fault, submode=None)
    assert env["AGENT_FI_RUN_ID"] == "run-1"
    assert env["AGENT_FI_FAULT_SKILL"] == "fake"
    assert "AGENT_RAS_RUN_ID" not in env
    assert "AGENT_INSIGHT_RAS_HOME" not in env
    assert "RAS_DETECTION_START_CHARS" not in env


def test_strip_ras_detector_env_drops_parent_overrides() -> None:
    cleaned = strip_ras_detector_env(
        {
            "PATH": "/usr/bin",
            "RAS_DETECTION_START_CHARS": "200",
            "RAS_SEMANTIC_EVAL_CHARS": "1500",
            "RAS_DET_EXAMPLE_THRESHOLD": "9",
            "AGENT_FI_RUN_ID": "run-1",
        }
    )
    assert cleaned["PATH"] == "/usr/bin"
    assert cleaned["AGENT_FI_RUN_ID"] == "run-1"
    assert "RAS_DETECTION_START_CHARS" not in cleaned
    assert "RAS_SEMANTIC_EVAL_CHARS" not in cleaned
    assert "RAS_DET_EXAMPLE_THRESHOLD" not in cleaned


def test_opencode_runtime_env_strips_detector_keys(monkeypatch) -> None:
    monkeypatch.setenv("RAS_DETECTION_START_CHARS", "99")
    monkeypatch.setenv("RAS_LOOP_REPEAT_THRESHOLD", "2")
    env = OpenCodeAdapter.build_runtime_env(
        fi_injection={"AGENT_FI_RUN_ID": "run-1"}
    )
    assert env["AGENT_FI_RUN_ID"] == "run-1"
    assert "RAS_DETECTION_START_CHARS" not in env
    assert "RAS_LOOP_REPEAT_THRESHOLD" not in env
