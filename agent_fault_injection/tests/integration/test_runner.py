import json
import tempfile
import unittest
from pathlib import Path

from agent_fault_injection.fault_inject.catalog.definition import FaultRegistry
from agent_fault_injection.pipeline.models import (
    PlatformRunResult,
    RunRequest,
    RunStatus,
    TerminationReason,
)
from agent_fault_injection.platform_adapters.base import PlatformAdapter
from agent_fault_injection.platform_adapters.opencode.mapper import (
    OpenCodeTrajectoryMapper,
)
from agent_fault_injection.pipeline.runner import ExperimentRunner


class FakeOpenCodeAdapter(PlatformAdapter):
    name = "opencode"

    def install_fault_assets(self, ctx):  # noqa: ANN001
        return None

    def merge_platform_env(self, ctx, environment):  # noqa: ANN001
        return dict(environment)

    async def run_platform_session(self, ctx, environment):  # noqa: ANN001
        raise AssertionError("execute override should be used")

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


class PluginStartFailedAdapter(PlatformAdapter):
    name = "opencode"

    def install_fault_assets(self, ctx):  # noqa: ANN001
        return None

    def merge_platform_env(self, ctx, environment):  # noqa: ANN001
        return dict(environment)

    async def run_platform_session(self, ctx, environment):  # noqa: ANN001
        raise AssertionError("execute override should be used")

    async def execute(self, request, fault, artifacts, store):
        from agent_fault_injection.pipeline.exceptions import PluginStartupError

        raise PluginStartupError("Platform plugin did not become ready within 120s")

    def map_trajectory(self, request, fault, artifacts):
        return None


class PluginStartFailedRegistry:
    def get(self, name):
        if name != "opencode":
            raise AssertionError(name)
        return PluginStartFailedAdapter()


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
                progress_callback=lambda event, details: progress_events.append(
                    (event, details)
                ),
            )

            result = await runner.run(request)

            self.assertEqual(result.status, RunStatus.COMPLETED)
            self.assertEqual(
                [event for event, _ in progress_events],
                [
                    "created",
                    "agent_execution_finished",
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
            self.assertTrue(
                (result.artifacts.root / "collect-result.json").is_file()
            )
            collect = json.loads(
                (result.artifacts.root / "collect-result.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(collect.get("injectionEvidence"), {})
            manifest = json.loads(
                result.artifacts.manifest_file.read_text(encoding="utf-8")
            )
            self.assertEqual(manifest["status"], "completed")
            self.assertTrue(manifest.get("fault_activated"))

    async def test_completed_collection_survives_interrupted_agent(self) -> None:
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

    async def test_plugin_start_failed_stays_failed_without_trace(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request = RunRequest(
                platform="opencode",
                agent="build",
                fault="thinking-dead-loop",
                prompt="use thinking-dead-loop",
                workspace=root,
                output_dir=root / "artifacts",
            )
            runner = ExperimentRunner(
                fault_registry=FaultRegistry(),
                platform_registry=PluginStartFailedRegistry(),
            )

            result = await runner.run(request)

            self.assertEqual(result.status, RunStatus.FAILED)
            self.assertEqual(
                result.termination_reason,
                TerminationReason.PLUGIN_START_FAILED,
            )
            collect_path = result.artifacts.root / "collect-result.json"
            self.assertTrue(collect_path.is_file())
            collect = json.loads(collect_path.read_text(encoding="utf-8"))
            self.assertFalse(collect.get("faultActivated"))
            self.assertIsNone(collect.get("taskId"))
            self.assertFalse(collect.get("sessionAligned"))
            manifest = json.loads(
                result.artifacts.manifest_file.read_text(encoding="utf-8")
            )
            self.assertEqual(manifest["status"], "failed")
            self.assertEqual(manifest["termination_reason"], "plugin_start_failed")
            self.assertIn("PluginStartupError", manifest.get("error") or "")


if __name__ == "__main__":
    unittest.main()
