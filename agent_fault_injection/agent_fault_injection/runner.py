"""Top-level experiment orchestration."""

from __future__ import annotations

import json
from collections.abc import Callable
from datetime import UTC, datetime

from .artifact_store import ArtifactStore
from .exceptions import (
    AgentRasEvalError,
    ExperimentTimeoutError,
    PluginStartupError,
)
from .evaluation import OpenCodeFaultJudge
from .fault_inject.models import FaultDefinition
from .fault_inject.registry import FaultRegistry
from .models import (
    PlatformRunResult,
    RunArtifacts,
    RunRequest,
    RunResult,
    RunStatus,
    TerminationReason,
)
from .platform_adapters.registry import PlatformAdapterRegistry
from .trace import InsightInteractionsMapper, write_interactions_artifact
from .collect_payload import build_collect_payload, write_collect_payload


class ExperimentRunner:
    def __init__(
        self,
        fault_registry: FaultRegistry | None = None,
        platform_registry: PlatformAdapterRegistry | None = None,
        judge: OpenCodeFaultJudge | None = None,
        progress_callback: (
            Callable[[str, dict[str, object]], None] | None
        ) = None,
    ) -> None:
        self.fault_registry = fault_registry or FaultRegistry()
        self.platform_registry = platform_registry or PlatformAdapterRegistry()
        self.judge = judge or OpenCodeFaultJudge()
        self.progress_callback = progress_callback

    def _emit_progress(self, event: str, **details: object) -> None:
        if self.progress_callback is not None:
            self.progress_callback(event, details)

    @staticmethod
    def _append_evaluation_event(
        artifacts: RunArtifacts,
        request: RunRequest,
        fault: FaultDefinition,
        platform_result: PlatformRunResult,
        kind: str,
        payload: dict[str, object],
    ) -> None:
        sequence = 0
        if artifacts.trajectory_file.is_file():
            with artifacts.trajectory_file.open("r", encoding="utf-8") as stream:
                for line in stream:
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    value = event.get("sequence")
                    if isinstance(value, int):
                        sequence = max(sequence, value)
        sequence += 1
        event = {
            "schema_version": "1",
            "event_id": f"{artifacts.run_id}:evaluation:{sequence}",
            "run_id": artifacts.run_id,
            "platform": request.platform,
            "agent": request.agent,
            "fault": {
                "name": fault.name,
                "skill": fault.skill_name,
            },
            "phase": "evaluation",
            "sequence": sequence,
            "timestamp": int(datetime.now(UTC).timestamp() * 1000),
            "kind": kind,
            "session_id": platform_result.session_id,
            "payload": payload,
        }
        with artifacts.trajectory_file.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(event, ensure_ascii=False) + "\n")

    @staticmethod
    def _evaluation_artifacts(artifacts: RunArtifacts) -> list[str]:
        candidates = (
            "judge-request.json",
            "judge-result.json",
            "raw/judge-stdout.log",
            "raw/judge-stderr.log",
            "authoritative-verifier.json",
            "raw/authoritative-verifier-stdout.log",
            "raw/authoritative-verifier-stderr.log",
        )
        return [
            relative
            for relative in candidates
            if (artifacts.root / relative).is_file()
        ]

    @staticmethod
    def _evaluation_collection(artifacts: RunArtifacts) -> dict[str, object]:
        request_file = artifacts.root / "judge-request.json"
        if not request_file.is_file():
            return {}
        try:
            request = json.loads(request_file.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return {}
        collection = request.get("collection")
        result = dict(collection) if isinstance(collection, dict) else {}
        session_error = request.get("session_error")
        if isinstance(session_error, str):
            result["session_error"] = session_error
        protection = request.get("platform_protection")
        if isinstance(protection, dict):
            result["platform_protection"] = protection
        return result

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

            platform_successful = (
                platform_result.exit_code == 0
                and platform_result.fault_activated
                and platform_result.termination_reason
                not in {
                    TerminationReason.SESSION_ERROR,
                    TerminationReason.PLATFORM_ERROR,
                }
            )
            evaluation = None
            evaluation_error = None
            judge_enabled = bool(
                request.platform_options.get("judge_enabled", False)
            )
            if judge_enabled and platform_result.fault_activated:
                self._append_evaluation_event(
                    artifacts,
                    request,
                    fault,
                    platform_result,
                    "evaluation.started",
                    {
                        "judge_agent": request.platform_options.get(
                            "judge_agent",
                            "ras-judge",
                        ),
                        "judge_model": request.platform_options.get(
                            "judge_model",
                            request.platform_options.get("model"),
                        ),
                        "judge_pure": request.platform_options.get(
                            "judge_pure",
                            True,
                        ),
                    },
                )
                self._emit_progress(
                    "fault_verification_started",
                    run_id=artifacts.run_id,
                )
                try:
                    evaluation = await self.judge.evaluate(
                        request=request,
                        fault=fault,
                        artifacts=artifacts,
                        platform_result=platform_result,
                        store=store,
                    )
                except Exception as exc:
                    evaluation_error = f"{type(exc).__name__}: {exc}"
                    self._append_evaluation_event(
                        artifacts,
                        request,
                        fault,
                        platform_result,
                        "evaluation.failed",
                        {
                            "error": evaluation_error,
                            "artifacts": self._evaluation_artifacts(artifacts),
                        },
                    )
                else:
                    self._append_evaluation_event(
                        artifacts,
                        request,
                        fault,
                        platform_result,
                        "evaluation.completed",
                        {
                            "outcome": evaluation.outcome,
                            "reason": evaluation.reason,
                            "fault_containment_status": (
                                evaluation.fault_containment_status
                            ),
                            "collection": self._evaluation_collection(
                                artifacts
                            ),
                            "artifacts": self._evaluation_artifacts(artifacts),
                        },
                    )
            else:
                self._append_evaluation_event(
                    artifacts,
                    request,
                    fault,
                    platform_result,
                    "evaluation.skipped",
                    {
                        "reason": (
                            "judge_disabled"
                            if not judge_enabled
                            else "fault_not_activated"
                        )
                    },
                )

            if judge_enabled and platform_result.fault_activated:
                successful = (
                    evaluation is not None and evaluation_error is None
                )
            else:
                successful = (
                    platform_successful and evaluation_error is None
                )
            status = RunStatus.COMPLETED if successful else RunStatus.FAILED
            evaluation_status = (
                "completed"
                if evaluation is not None
                else "failed"
                if evaluation_error is not None
                else "skipped"
            )
            result_exit_code = (
                1
                if evaluation_error is not None
                and platform_result.exit_code == 0
                else platform_result.exit_code
            )
            evaluation_collection = self._evaluation_collection(artifacts)
            fault_containment_status = (
                evaluation.fault_containment_status
                if evaluation is not None
                else None
            )
            # Refresh interactions.json so evaluation markers are included.
            trace_document = InsightInteractionsMapper().map(
                artifacts,
                framework=request.platform,
                prompt=request.prompt,
                session_id=platform_result.session_id,
            )
            write_interactions_artifact(artifacts, trace_document)
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
                evaluation_status=evaluation_status,
                fault_outcome=(
                    evaluation.outcome if evaluation is not None else None
                ),
                fault_reason=(
                    evaluation.reason if evaluation is not None else None
                ),
                evaluation_error=evaluation_error,
                evaluation_collection=evaluation_collection,
                fault_containment_status=fault_containment_status,
                evaluation=(
                    str(artifacts.root / "judge-result.json")
                    if evaluation is not None
                    else None
                ),
            )
            try:
                collect = build_collect_payload(
                    artifacts,
                    framework=request.platform,
                    fault=fault.name,
                    injection_method=getattr(fault, "injection_method", None) or getattr(fault, "injection_method", "skill_inject"),
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
                error=evaluation_error,
                fault_outcome=(
                    evaluation.outcome if evaluation is not None else None
                ),
                fault_reason=(
                    evaluation.reason if evaluation is not None else None
                ),
                evaluation_error=evaluation_error,
                fault_containment_status=fault_containment_status,
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
