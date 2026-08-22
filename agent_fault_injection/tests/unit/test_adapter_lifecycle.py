"""Lifecycle Template Method smoke tests with a fake SPI adapter."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import pytest

from agent_fault_injection.fault_inject.catalog.models import FaultDefinition
from agent_fault_injection.pipeline.models import (
    PlatformRunResult,
    RunRequest,
    RunStatus,
    TerminationReason,
)
from agent_fault_injection.platform_adapters.base import PlatformAdapter
from agent_fault_injection.platform_adapters.lifecycle import AdapterRunContext


class _FakeAdapter(PlatformAdapter):
    name = "fake"

    def __init__(self) -> None:
        self.calls: list[str] = []

    def install_fault_assets(self, ctx: AdapterRunContext) -> None:
        self.calls.append("install")

    def prepare_runtime_isolation(self, ctx: AdapterRunContext) -> str:
        self.calls.append("isolate")
        return "iso"

    def merge_platform_env(
        self,
        ctx: AdapterRunContext,
        base_env: dict[str, str],
    ) -> dict[str, str]:
        self.calls.append("merge")
        assert "AGENT_FI_FAULT_SKILL" in base_env
        env = dict(base_env)
        env["FAKE"] = "1"
        return env

    async def run_platform_session(
        self,
        ctx: AdapterRunContext,
        environment: dict[str, str],
    ) -> PlatformRunResult:
        self.calls.append("run")
        assert environment.get("FAKE") == "1"
        return PlatformRunResult(
            exit_code=0,
            termination_reason=TerminationReason.PROCESS_EXITED,
            fault_activated=True,
        )

    def teardown_isolation(self, ctx: AdapterRunContext) -> None:
        self.calls.append("teardown")

    def map_trajectory(self, request, fault, artifacts) -> None:  # noqa: ANN001
        self.calls.append("map")


@pytest.mark.asyncio
async def test_template_method_order(tmp_path: Path) -> None:
    workspace = tmp_path / "ws"
    workspace.mkdir()
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
    artifacts.events_file = artifacts.raw_dir / "events.jsonl"
    artifacts.events_file.write_text("", encoding="utf-8")
    artifacts.resolved_fault_dir = tmp_path / "fault"
    artifacts.resolved_fault_dir.mkdir()
    artifacts.plugin_ready_file = artifacts.raw_dir / "ready"
    store = MagicMock()
    request = RunRequest(
        run_id="run-1",
        platform="fake",
        agent="a",
        fault="fake",
        prompt="p",
        workspace=workspace,
        output_dir=tmp_path / "out",
    )
    adapter = _FakeAdapter()
    result = await adapter.execute(request, fault, artifacts, store)
    assert result.fault_activated is True
    assert adapter.calls == ["install", "isolate", "merge", "run", "teardown"]
    store.update_manifest.assert_any_call(artifacts, status=RunStatus.PREPARING)
