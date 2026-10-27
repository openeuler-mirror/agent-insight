# Copyright (c) 2026 Huawei Technologies Co., Ltd.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Contract implemented by every supported agent platform."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

from ..pipeline.artifact_store import ArtifactStore
from ..fault_inject.catalog.models import FaultDefinition
from ..pipeline.models import PlatformRunResult, RunArtifacts, RunRequest
from .lifecycle import (
    AdapterRunContext,
    apply_structural_plan,
    assert_fault_tools_installed,
    build_fi_injection_env,
    copy_skill_artifact,
    mark_preparing,
    strip_ras_detector_env,
    validate_workspace,
)


class PlatformAdapter(ABC):
    """Platform-specific inject / execute / trajectory mapping.

    ``execute`` is a Template Method: shared prepare + structural plan +
    AGENT_FI_* env; subclasses implement SPI hooks only.
    """

    name: str

    async def execute(
        self,
        request: RunRequest,
        fault: FaultDefinition,
        artifacts: RunArtifacts,
        store: ArtifactStore,
    ) -> PlatformRunResult:
        workspace = validate_workspace(request)
        ctx = AdapterRunContext(
            request=request,
            fault=fault,
            artifacts=artifacts,
            store=store,
            workspace=workspace,
        )
        try:
            mark_preparing(ctx)
            self.install_fault_assets(ctx)
            assert_fault_tools_installed(fault=fault, workspace=workspace)
            copy_skill_artifact(fault, artifacts)
            apply_structural_plan(
                fault=fault,
                artifacts=artifacts,
                workspace=workspace,
                installation=ctx.installation,
                submode=request.submode,
            )
            ctx.isolation = self.prepare_runtime_isolation(ctx)
            base_env = build_fi_injection_env(
                artifacts=artifacts,
                fault=fault,
                submode=request.submode,
            )
            environment = strip_ras_detector_env(
                self.merge_platform_env(ctx, base_env)
            )
            return await self.run_platform_session(ctx, environment)
        finally:
            try:
                self.teardown_isolation(ctx)
            finally:
                ctx.installation.cleanup()

    @abstractmethod
    def install_fault_assets(self, ctx: AdapterRunContext) -> None:
        """Install skill/tools into platform-specific workspace paths."""

    def prepare_runtime_isolation(self, ctx: AdapterRunContext) -> Any:
        """Optional isolated config / plugin overlay; default is none."""

        return None

    @abstractmethod
    def merge_platform_env(
        self,
        ctx: AdapterRunContext,
        base_env: dict[str, str],
    ) -> dict[str, str]:
        """Merge platform keys onto shared AGENT_FI_* env (do not drop them)."""

    @abstractmethod
    async def run_platform_session(
        self,
        ctx: AdapterRunContext,
        environment: dict[str, str],
    ) -> PlatformRunResult:
        """Launch agent (CLI/daemon), wait ready, monitor until exit."""

    def teardown_isolation(self, ctx: AdapterRunContext) -> None:
        """Optional cleanup for ``prepare_runtime_isolation``; default no-op."""

    @abstractmethod
    def map_trajectory(
        self,
        request: RunRequest,
        fault: FaultDefinition,
        artifacts: RunArtifacts,
    ) -> None:
        """Map raw platform events into trajectory + execution.jsonl."""

    def list_agents(self, **kwargs: Any) -> dict[str, Any]:
        return {
            "platform": self.name,
            "default": None,
            "agents": [],
            "note": (
                f"Agent enumeration is not implemented for platform "
                f"{self.name!r}."
            ),
        }

    def list_models(self, **kwargs: Any) -> dict[str, Any]:
        return {
            "platform": self.name,
            "default": None,
            "models": [],
            "note": (
                f"Model enumeration is not implemented for platform "
                f"{self.name!r}."
            ),
        }

    def health_check(self) -> dict[str, Any]:
        """Return ``{ready: bool, errors: list[str], details?: dict}``."""
        return {"ready": True, "errors": []}
