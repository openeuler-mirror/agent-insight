import json
import tempfile
import unittest
from pathlib import Path

from agent_fault_injection.fault_inject.registry import FaultRegistry
from agent_fault_injection.models import (
    FaultContainmentStatus,
    FaultEvaluation,
    FaultOutcome,
    PlatformRunResult,
    RunRequest,
    RunStatus,
    TerminationReason,
)
from agent_fault_injection.platform_adapters.base import PlatformAdapter
from agent_fault_injection.platform_adapters.opencode.mapper import (
    OpenCodeTrajectoryMapper,
)
from agent_fault_injection.runner import ExperimentRunner


class FakeOpenCodeAdapter(PlatformAdapter):
    name = "opencode"

    async def execute(self, request, fault, artifacts, store):
        rows = [
            {
                "sequence": 1,
                "recorded_at": 1,
                "kind": "fault.activation.started",
                "payload": {"sessionID": "ses_fake"},
            },
            {
                "sequence": 2,
                "recorded_at": 2,
                "kind": "fault.activation.completed",
                "payload": {"sessionID": "ses_fake"},
            },
            {
                "sequence": 3,
                "recorded_at": 3,
                "kind": "opencode.event",
                "payload": {
                    "type": "session.idle",
                    "properties": {"sessionID": "ses_fake"},
                },
            },
        ]
        artifacts.events_file.write_text(
            "".join(json.dumps(row) + "\n" for row in rows),
            encoding="utf-8",
        )
        return PlatformRunResult(
            exit_code=0,
            termination_reason=TerminationReason.SESSION_IDLE,
            session_id="ses_fake",
            fault_activated=True,
        )

    def map_trajectory(self, request, fault, artifacts):
        OpenCodeTrajectoryMapper().map(request, fault, artifacts)


class InterruptedOpenCodeAdapter(FakeOpenCodeAdapter):
    async def execute(self, request, fault, artifacts, store):
        result = await super().execute(request, fault, artifacts, store)
        return PlatformRunResult(
            exit_code=1,
            termination_reason=TerminationReason.SESSION_ERROR,
            session_id=result.session_id,
            fault_activated=True,
        )


class FakePlatformRegistry:
    def get(self, name):
        if name != "opencode":
            raise AssertionError(name)
        return FakeOpenCodeAdapter()


class InterruptedPlatformRegistry:
    def get(self, name):
        if name != "opencode":
            raise AssertionError(name)
        return InterruptedOpenCodeAdapter()


class FakeJudge:
    async def evaluate(self, request, fault, artifacts, platform_result, store):
        return FaultEvaluation(
            outcome=FaultOutcome.OCCURRED,
            fault_containment_status=FaultContainmentStatus.UNRESOLVED,
            reason="fake adapter followed the injected behavior",
        )


class ProtectingJudge:
    async def evaluate(self, request, fault, artifacts, platform_result, store):
        store.write_json(
            artifacts.root / "judge-request.json",
            {
                "collection": {},
                "platform_protection": {
                    "triggered": True,
                    "type": "repetition_guard",
                },
            },
        )
        return FaultEvaluation(
            outcome=FaultOutcome.OCCURRED,
            fault_containment_status=FaultContainmentStatus.RECOVERED,
            reason="repetition was stopped by the platform guard",
        )


class FailingJudge:
    async def evaluate(self, request, fault, artifacts, platform_result, store):
        raise ValueError("invalid judge response")


class RunnerIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_runner_selects_adapter_and_writes_trajectory(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            progress_events = []
            request = RunRequest(
                platform="opencode",
                agent="build",
                fault="step-omission",
                prompt="test",
                workspace=root,
                output_dir=root / "artifacts",
            )
            runner = ExperimentRunner(
                fault_registry=FaultRegistry(),
                platform_registry=FakePlatformRegistry(),
                judge=FakeJudge(),
                progress_callback=lambda event, details: progress_events.append(
                    (event, details)
                ),
            )

            result = await runner.run(request)

            self.assertEqual(result.status, RunStatus.COMPLETED)
            self.assertEqual(result.fault_outcome, FaultOutcome.OCCURRED)
            self.assertEqual(
                result.fault_containment_status,
                FaultContainmentStatus.UNRESOLVED,
            )
            self.assertEqual(
                [event for event, _ in progress_events],
                [
                    "created",
                    "agent_execution_finished",
                    "fault_verification_started",
                ],
            )
            created_details = progress_events[0][1]
            self.assertEqual(created_details["run_id"], result.run_id)
            self.assertEqual(created_details["platform"], "opencode")
            self.assertEqual(created_details["fault"], "step-omission")
            self.assertEqual(
                Path(created_details["artifacts"]),
                result.artifacts.root,
            )
            execution_details = next(
                details
                for event, details in progress_events
                if event == "agent_execution_finished"
            )
            self.assertEqual(
                execution_details["termination_reason"],
                TerminationReason.SESSION_IDLE,
            )
            self.assertEqual(execution_details["platform"], "opencode")
            self.assertEqual(execution_details["agent"], "build")
            self.assertEqual(execution_details["fault"], "step-omission")
            self.assertTrue(
                Path(execution_details["trajectory"]).is_file()
            )
            self.assertTrue(result.artifacts.trajectory_file.is_file())
            trajectory = [
                json.loads(line)
                for line in result.artifacts.trajectory_file.read_text(
                    encoding="utf-8"
                ).splitlines()
            ]
            self.assertEqual(
                [event["kind"] for event in trajectory[-2:]],
                ["evaluation.started", "evaluation.completed"],
            )
            self.assertTrue(
                all(
                    event["phase"] == "evaluation"
                    for event in trajectory[-2:]
                )
            )
            self.assertEqual(
                trajectory[-1]["payload"]["outcome"],
                "occurred",
            )
            self.assertEqual(
                trajectory[-1]["payload"]["fault_containment_status"],
                "unresolved",
            )
            manifest = json.loads(
                result.artifacts.manifest_file.read_text(encoding="utf-8")
            )
            self.assertEqual(manifest["status"], "completed")
            self.assertEqual(manifest["fault_outcome"], "occurred")
            self.assertEqual(manifest["fault_containment_status"], "unresolved")
            self.assertEqual(manifest["evaluation_status"], "completed")

    async def test_completed_judging_survives_interrupted_agent(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            progress_events = []
            request = RunRequest(
                platform="opencode",
                agent="build",
                fault="step-omission",
                prompt="test",
                workspace=root,
                output_dir=root / "artifacts",
            )
            runner = ExperimentRunner(
                fault_registry=FaultRegistry(),
                platform_registry=InterruptedPlatformRegistry(),
                judge=ProtectingJudge(),
                progress_callback=lambda event, details: progress_events.append(
                    (event, details)
                ),
            )

            result = await runner.run(request)

            self.assertEqual(result.status, RunStatus.COMPLETED)
            self.assertEqual(
                result.termination_reason,
                TerminationReason.SESSION_ERROR,
            )
            self.assertEqual(result.fault_outcome, FaultOutcome.OCCURRED)
            self.assertEqual(
                result.fault_containment_status,
                FaultContainmentStatus.RECOVERED,
            )
            self.assertEqual(
                next(
                    details
                    for event, details in progress_events
                    if event == "agent_execution_finished"
                )["execution_status"],
                "interrupted",
            )
            manifest = json.loads(
                result.artifacts.manifest_file.read_text(encoding="utf-8")
            )
            self.assertEqual(manifest["status"], "completed")
            self.assertEqual(
                manifest["agent_execution_status"],
                "interrupted",
            )
            self.assertEqual(
                manifest["fault_containment_status"],
                "recovered",
            )

    async def test_runner_marks_evaluation_failure_without_losing_termination(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request = RunRequest(
                platform="opencode",
                agent="build",
                fault="step-omission",
                prompt="test",
                workspace=root,
                output_dir=root / "artifacts",
            )
            runner = ExperimentRunner(
                fault_registry=FaultRegistry(),
                platform_registry=FakePlatformRegistry(),
                judge=FailingJudge(),
            )

            result = await runner.run(request)

            self.assertEqual(result.status, RunStatus.FAILED)
            self.assertEqual(
                result.termination_reason,
                TerminationReason.SESSION_IDLE,
            )
            self.assertIn("invalid judge response", result.evaluation_error)
            trajectory = [
                json.loads(line)
                for line in result.artifacts.trajectory_file.read_text(
                    encoding="utf-8"
                ).splitlines()
            ]
            self.assertEqual(
                [event["kind"] for event in trajectory[-2:]],
                ["evaluation.started", "evaluation.failed"],
            )
            self.assertIn(
                "invalid judge response",
                trajectory[-1]["payload"]["error"],
            )
            manifest = json.loads(
                result.artifacts.manifest_file.read_text(encoding="utf-8")
            )
            self.assertEqual(manifest["evaluation_status"], "failed")


if __name__ == "__main__":
    unittest.main()
