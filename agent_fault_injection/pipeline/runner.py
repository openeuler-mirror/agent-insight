"""Top-level experiment orchestration (inject → run → collect)."""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime

from .artifact_store import ArtifactStore
from .collect_payload import build_collect_payload, write_collect_payload
from .exceptions import (
    AgentRasEvalError,
    ExperimentTimeoutError,
    PluginStartupError,
)
from ..fault_inject.catalog.models import FaultDefinition
from ..fault_inject.catalog.registry import FaultRegistry
from .models import (
    RunArtifacts,
    RunRequest,
    RunResult,
    RunStatus,
    TerminationReason,
)
from ..platform_adapters.registry import PlatformAdapterRegistry
from .interactions_mapper import InsightInteractionsMapper, write_interactions_artifact


class ExperimentRunner:
    def __init__(
        self,
        fault_registry: FaultRegistry | None = None,
        platform_registry: PlatformAdapterRegistry | None = None,
        progress_callback: (
            Callable[[str, dict[str, object]], None] | None
        ) = None,
    ) -> None:
        self.fault_registry = fault_registry or FaultRegistry()
        self.platform_registry = platform_registry or PlatformAdapterRegistry()
        self.progress_callback = progress_callback

    def _emit_progress(self, event: str, **details: object) -> None:
        if self.progress_callback is not None:
            self.progress_callback(event, details)

    async def run(self, request: RunRequest) -> RunResult:
        fault = self.fault_registry.get(request.fault)
        adapter = self.platform_registry.get(request.platform)
        store = ArtifactStore(request.output_dir)
        artifacts = store.create(request)
        self._emit_progress(
            "created",
            run_id=artifacts.run_id,
            artifacts=str(artifacts.root),
            platform=request.platform,
            fault=fault.name,
        )

        try:
            platform_result = await adapter.execute(
                request=request,
                fault=fault,
                artifacts=artifacts,
                store=store,
            )
            agent_execution_status = (
                "interrupted"
                if platform_result.exit_code != 0
                or platform_result.termination_reason
                in {
                    TerminationReason.SESSION_ERROR,
                    TerminationReason.PLATFORM_ERROR,
                }
                else "finished"
            )
            store.update_manifest(artifacts, status=RunStatus.MAPPING)
            adapter.map_trajectory(request, fault, artifacts)
            trace_document = InsightInteractionsMapper().map(
                artifacts,
                framework=request.platform,
                prompt=request.prompt,
                session_id=platform_result.session_id,
            )
            write_interactions_artifact(artifacts, trace_document)
            store.update_manifest(
                artifacts,
                framework=request.platform,
                taskId=trace_document.task_id,
                interactions="interactions.json",
                interaction_count=len(trace_document.interactions),
            )
            self._emit_progress(
                "agent_execution_finished",
                run_id=artifacts.run_id,
                platform=request.platform,
                agent=request.agent,
                fault=fault.name,
                workspace=str(request.workspace),
                execution_status=agent_execution_status,
                exit_code=platform_result.exit_code,
                termination_reason=platform_result.termination_reason,
                fault_activated=platform_result.fault_activated,
                trajectory=str(artifacts.trajectory_file),
                interactions=str(artifacts.interactions_file),
                artifacts=str(artifacts.root),
            )

            # Collection succeeds once the fault skill activated, even if the
            # agent session later aborts (e.g. thinking-dead-loop).
            successful = (
                platform_result.fault_activated
                and platform_result.termination_reason
                not in {TerminationReason.USER_INTERRUPT}
            )
            status = RunStatus.COMPLETED if successful else RunStatus.FAILED
            result_exit_code = 0 if successful else platform_result.exit_code

            store.update_manifest(
                artifacts,
                status=status,
                completed_at=datetime.now(UTC).isoformat(),
                agent_execution_status=agent_execution_status,
                exit_code=platform_result.exit_code,
                termination_reason=platform_result.termination_reason,
                session_id=platform_result.session_id,
                taskId=trace_document.task_id,
                framework=request.platform,
                fault_activated=platform_result.fault_activated,
                trajectory=str(artifacts.trajectory_file),
                interactions=str(artifacts.interactions_file),
                interaction_count=len(trace_document.interactions),
            )
            try:
                collect = build_collect_payload(
                    artifacts,
                    framework=request.platform,
                    fault=fault.name,
                    injection_method=getattr(fault, "injection_method", None)
                    or "skill_inject",
                    fault_activated=bool(platform_result.fault_activated),
                    session_id=platform_result.session_id,
                )
                write_collect_payload(artifacts, collect)
            except Exception:
                pass

            return RunResult(
                run_id=artifacts.run_id,
                status=status,
                termination_reason=platform_result.termination_reason,
                artifacts=artifacts,
                exit_code=result_exit_code,
            )
        except KeyboardInterrupt:
            store.update_manifest(
                artifacts,
                status=RunStatus.FAILED,
                termination_reason=TerminationReason.USER_INTERRUPT,
            )
            return RunResult(
                run_id=artifacts.run_id,
                status=RunStatus.FAILED,
                termination_reason=TerminationReason.USER_INTERRUPT,
                artifacts=artifacts,
                exit_code=130,
                error="Experiment interrupted by user",
            )
        except ExperimentTimeoutError as exc:
            self._best_effort_collect(
                request=request,
                fault=fault,
                artifacts=artifacts,
                store=store,
                adapter=adapter,
            )
            return self._failure(
                store,
                artifacts,
                TerminationReason.TIMEOUT,
                exc,
                exit_code=124,
            )
        except AgentRasEvalError as exc:
            reason = (
                TerminationReason.PLUGIN_START_FAILED
                if isinstance(exc, PluginStartupError)
                else TerminationReason.PLATFORM_ERROR
            )
            self._best_effort_collect(
                request=request,
                fault=fault,
                artifacts=artifacts,
                store=store,
                adapter=adapter,
            )
            recovered = self._completed_from_collect_if_activated(
                store=store,
                artifacts=artifacts,
                reason=reason,
                error=exc,
            )
            if recovered is not None:
                return recovered
            return self._failure(store, artifacts, reason, exc)
        except Exception as exc:
            try:
                self._best_effort_collect(
                    request=request,
                    fault=fault,
                    artifacts=artifacts,
                    store=store,
                    adapter=adapter,
                )
            except Exception:
                pass
            recovered = self._completed_from_collect_if_activated(
                store=store,
                artifacts=artifacts,
                reason=TerminationReason.PLATFORM_ERROR,
                error=exc,
            )
            if recovered is not None:
                return recovered
            return self._failure(
                store,
                artifacts,
                TerminationReason.PLATFORM_ERROR,
                exc,
            )

    def _best_effort_collect(
        self,
        *,
        request,
        fault,
        artifacts,
        store: ArtifactStore,
        adapter,
    ) -> None:
        """On timeout/failure, still map interactions + collect-result when possible."""
        try:
            adapter.map_trajectory(request, fault, artifacts)
        except Exception:
            pass
        try:
            trace_document = InsightInteractionsMapper().map(
                artifacts,
                framework=request.platform,
                prompt=request.prompt,
                session_id=None,
            )
            write_interactions_artifact(artifacts, trace_document)
            store.update_manifest(
                artifacts,
                framework=request.platform,
                taskId=trace_document.task_id,
                interactions="interactions.json",
                interaction_count=len(trace_document.interactions),
            )
            collect = build_collect_payload(
                artifacts,
                framework=request.platform,
                fault=fault.name,
                injection_method=getattr(fault, "injection_method", None)
                or "skill_inject",
                fault_activated=True,
                session_id=trace_document.task_id,
            )
            write_collect_payload(artifacts, collect)
        except Exception:
            pass

    @staticmethod
    def _collect_fault_activated(artifacts: RunArtifacts) -> bool:
        import json

        path = artifacts.root / "collect-result.json"
        if not path.is_file():
            return False
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return False
        return bool(payload.get("faultActivated"))

    def _completed_from_collect_if_activated(
        self,
        *,
        store: ArtifactStore,
        artifacts: RunArtifacts,
        reason: TerminationReason,
        error: Exception,
    ) -> RunResult | None:
        """Worker path: fault already activated + collect written → success."""

        if not self._collect_fault_activated(artifacts):
            return None
        message = f"{type(error).__name__}: {error}"
        store.update_manifest(
            artifacts,
            status=RunStatus.COMPLETED,
            termination_reason=reason,
            error=message,
            fault_activated=True,
            completed_at=datetime.now(UTC).isoformat(),
        )
        return RunResult(
            run_id=artifacts.run_id,
            status=RunStatus.COMPLETED,
            termination_reason=reason,
            artifacts=artifacts,
            exit_code=0,
            error=None,
        )

    @staticmethod
    def _failure(
        store: ArtifactStore,
        artifacts,
        reason: TerminationReason,
        error: Exception,
        exit_code: int = 1,
    ) -> RunResult:
        message = f"{type(error).__name__}: {error}"
        store.update_manifest(
            artifacts,
            status=RunStatus.FAILED,
            termination_reason=reason,
            error=message,
            completed_at=datetime.now(UTC).isoformat(),
        )
        return RunResult(
            run_id=artifacts.run_id,
            status=RunStatus.FAILED,
            termination_reason=reason,
            artifacts=artifacts,
            exit_code=exit_code,
            error=message,
        )
