import json
import tempfile
from pathlib import Path
from unittest import TestCase

from agent_fault_injection.fault_inject.catalog.definition import FaultRegistry
from agent_fault_injection.pipeline.models import RunArtifacts, RunRequest
from agent_fault_injection.platform_adapters.opencode.mapper import (
    OpenCodeTrajectoryMapper,
)


def _artifacts(root: Path) -> RunArtifacts:
    raw = root / "raw"
    raw.mkdir()
    return RunArtifacts(
        run_id="run-test",
        root=root,
        raw_dir=raw,
        resolved_fault_dir=root / "resolved_fault",
        events_file=raw / "events.jsonl",
        stdout_file=raw / "stdout.log",
        stderr_file=raw / "stderr.log",
        trajectory_file=root / "trajectory.jsonl",
        interactions_file=root / "interactions.json",
        execution_file=root / "execution.jsonl",
        manifest_file=root / "manifest.json",
        request_file=root / "request.json",
        plugin_ready_file=raw / "plugin-ready.json",
    )


class OpenCodeMapperTests(TestCase):
    def test_internal_reviewers_cannot_replace_legacy_business_session(self) -> None:
        """Replay the root/reviewer ordering observed in the failed experiment."""
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            artifacts = _artifacts(root)
            events = [
                {"kind": "fault.activation.requested", "payload": {"sessionID": "ses_build"}},
                {"kind": "fault.activation.completed", "payload": {"sessionID": "ses_build"}},
                {"kind": "fault.activation.requested", "payload": {"sessionID": "ses_judge"}},
                {"kind": "fault.activation.completed", "payload": {"sessionID": "ses_judge"}},
            ]
            artifacts.events_file.write_text(
                "".join(json.dumps(event) + "\n" for event in events), encoding="utf-8",
            )
            summary = OpenCodeTrajectoryMapper().inspect(artifacts.events_file)
            self.assertEqual(summary.session_id, "ses_build")
            self.assertTrue(summary.fault_activated)
            events[1]["kind"] = "tool.before"
            artifacts.events_file.write_text(
                "".join(json.dumps(event) + "\n" for event in events), encoding="utf-8",
            )
            self.assertFalse(OpenCodeTrajectoryMapper().inspect(artifacts.events_file).fault_activated)

    def test_explicit_root_binding_survives_unrelated_events_and_process_retry(self) -> None:
        """A new process root supersedes a failed attempt, not arbitrary session events."""
        with tempfile.TemporaryDirectory() as temporary:
            artifacts = _artifacts(Path(temporary))
            events = [
                {"kind": "run.session.bound", "payload": {"sessionID": "ses_old"}},
                {"kind": "fault.activation.completed", "payload": {"sessionID": "ses_old"}},
                {"kind": "run.session.bound", "payload": {"sessionID": "ses_retry"}},
                {"kind": "tool.after", "payload": {"sessionID": "ses_auxiliary"}},
            ]
            artifacts.events_file.write_text(
                "".join(json.dumps(event) + "\n" for event in events), encoding="utf-8",
            )
            summary = OpenCodeTrajectoryMapper().inspect(artifacts.events_file)
            self.assertEqual(summary.session_id, "ses_retry")
            self.assertFalse(summary.fault_activated)

    def test_maps_fault_activation_window(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            artifacts = _artifacts(root)
            rows = [
                {
                    "sequence": 1,
                    "recorded_at": 10,
                    "kind": "plugin.ready",
                    "payload": {},
                },
                {
                    "sequence": 2,
                    "recorded_at": 20,
                    "kind": "fault.activation.started",
                    "payload": {"sessionID": "ses_1"},
                },
                {
                    "sequence": 3,
                    "recorded_at": 30,
                    "kind": "fault.activation.completed",
                    "payload": {"sessionID": "ses_1"},
                },
                {
                    "sequence": 4,
                    "recorded_at": 40,
                    "kind": "fault.tool.after",
                    "payload": {"sessionID": "ses_1", "tool": "bash"},
                },
            ]
            artifacts.events_file.write_text(
                "".join(json.dumps(row) + "\n" for row in rows),
                encoding="utf-8",
            )
            request = RunRequest(
                platform="opencode",
                agent="build",
                fault="step-omission",
                prompt="test",
                workspace=root,
                output_dir=root,
            )

            summary = OpenCodeTrajectoryMapper().map(
                request,
                FaultRegistry().get("step-omission"),
                artifacts,
            )

            self.assertTrue(summary.fault_activated)
            self.assertEqual(summary.session_id, "ses_1")
            self.assertEqual(summary.event_count, 4)
            trajectory = [
                json.loads(line)
                for line in artifacts.trajectory_file.read_text(
                    encoding="utf-8"
                ).splitlines()
            ]
            self.assertEqual(
                [event["phase"] for event in trajectory],
                [
                    "bootstrap",
                    "fault_activation",
                    "fault_active",
                    "fault_active",
                ],
            )
            self.assertEqual(
                [event["kind"] for event in trajectory],
                [
                    "plugin.ready",
                    "fault.activation.started",
                    "fault.activation.completed",
                    "fault.tool.after",
                ],
            )
