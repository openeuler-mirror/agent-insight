"""Contract implemented by every supported agent platform."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

from ..artifact_store import ArtifactStore
from ..fault_inject.models import FaultDefinition
from ..models import PlatformRunResult, RunArtifacts, RunRequest


class PlatformAdapter(ABC):
    """Platform-specific inject / execute / trajectory mapping.

    Optional catalog helpers (``list_agents``, ``list_models``, ``health_check``)
    have default stubs so adapters may omit them until Web UI needs them.

    Common ``platform_options`` keys (documented, not schema-validated):
    ``judge_enabled``, ``judge_agent``, ``judge_model``, ``judge_timeout_seconds``,
    ``judge_executable``, ``model``, ``auto``, ``executable``,
    ``plugin_startup_timeout``. Platform-private keys share the same dict.
    """

    name: str

    @abstractmethod
    async def execute(
        self,
        request: RunRequest,
        fault: FaultDefinition,
        artifacts: RunArtifacts,
        store: ArtifactStore,
    ) -> PlatformRunResult:
        """Prepare, launch, observe, and clean up the platform."""

    @abstractmethod
    def map_trajectory(
        self,
        request: RunRequest,
        fault: FaultDefinition,
        artifacts: RunArtifacts,
    ) -> None:
        """Map raw platform events into the common trajectory representation.

        Adapters should also write normalized ``artifacts.execution_file``
        (``execution.jsonl``) so the shared OpenCode judge can consume evidence
        without platform-specific stdout parsing.
        """

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
