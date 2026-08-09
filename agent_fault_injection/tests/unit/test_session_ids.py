"""Unit tests for FI↔reliability Trace ID (= platform session) contract."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from agent_fault_injection.pipeline.collect_payload import build_collect_payload
from agent_fault_injection.pipeline.models import RunArtifacts
from agent_fault_injection.pipeline.session_ids import (
    is_platform_session_id,
    resolve_platform_session_id,
)
from agent_fault_injection.platform_adapters.opencode.mapper import _session_id


def _artifacts(root: Path) -> RunArtifacts:
    raw = root / "raw"
    raw.mkdir(parents=True, exist_ok=True)
    return RunArtifacts(
        run_id="ras-20260806T140959-abcdef12",
        root=root,
        raw_dir=raw,
        resolved_fault_dir=root / "resolved_fault",
        events_file=raw / "events.jsonl",
        session_file=raw / "session.json",
        stdout_file=raw / "stdout.log",
        stderr_file=raw / "stderr.log",
        trajectory_file=root / "trajectory.jsonl",
        interactions_file=root / "interactions.json",
        execution_file=root / "execution.jsonl",
        manifest_file=root / "manifest.json",
        request_file=root / "request.json",
        plugin_ready_file=raw / "plugin-ready.json",
    )


class SessionIdContractTests(unittest.TestCase):
    def test_rejects_run_id_and_message_id(self) -> None:
        self.assertFalse(is_platform_session_id("ras-20260806T140959-abcdef12"))
        self.assertFalse(is_platform_session_id("msg_fd75abd28001y1tQ54eWjHl14R"))
        self.assertTrue(is_platform_session_id("ses_028a561a4ffePqjMxKY7VGbqEs"))
        self.assertTrue(is_platform_session_id("6231e7cc-456d-403d-95e1-2fc8dc9c7a4e"))

    def test_platform_capture_beats_session_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            artifacts = _artifacts(root)
            artifacts.session_file.write_text(
                json.dumps({"session_id": "ses_stale"}),
                encoding="utf-8",
            )
            sid, aligned = resolve_platform_session_id(
                session_file=artifacts.session_file,
                platform_session_id="ses_fresh",
            )
            self.assertTrue(aligned)
            self.assertEqual(sid, "ses_fresh")

    def test_session_snapshot_fallback_when_platform_polluted(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            artifacts = _artifacts(root)
            artifacts.session_file.write_text(
                json.dumps({"session_id": "ses_real"}),
                encoding="utf-8",
            )
            sid, aligned = resolve_platform_session_id(
                session_file=artifacts.session_file,
                platform_session_id="msg_polluted",
            )
            self.assertTrue(aligned)
            self.assertEqual(sid, "ses_real")

    def test_collect_payload_does_not_use_run_id_as_task_id(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            artifacts = _artifacts(root)
            payload = build_collect_payload(
                artifacts,
                framework="opencode",
                fault="thinking-dead-loop",
                session_id=None,
            )
            self.assertIsNone(payload["taskId"])
            self.assertFalse(payload["sessionAligned"])
            self.assertEqual(payload["runId"], artifacts.run_id)

    def test_collect_payload_prefers_platform_over_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            artifacts = _artifacts(root)
            artifacts.session_file.write_text(
                json.dumps({"session_id": "ses_from_file"}),
                encoding="utf-8",
            )
            payload = build_collect_payload(
                artifacts,
                framework="opencode",
                fault="thinking-dead-loop",
                session_id="ses_from_platform",
            )
            self.assertEqual(payload["taskId"], "ses_from_platform")
            self.assertTrue(payload["sessionAligned"])

    def test_collect_payload_snapshot_fallback_rejects_message_id(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            artifacts = _artifacts(root)
            artifacts.session_file.write_text(
                json.dumps({"session_id": "ses_from_file"}),
                encoding="utf-8",
            )
            payload = build_collect_payload(
                artifacts,
                framework="opencode",
                fault="thinking-dead-loop",
                session_id="msg_should_not_win",
            )
            self.assertEqual(payload["taskId"], "ses_from_file")
            self.assertTrue(payload["sessionAligned"])

    def test_opencode_session_id_ignores_message_info_id(self) -> None:
        payload = {
            "type": "message.updated",
            "properties": {
                "info": {"id": "msg_abc", "sessionID": "ses_ok"},
            },
        }
        self.assertEqual(_session_id(payload), "ses_ok")
        polluted = {
            "type": "message.updated",
            "properties": {"info": {"id": "msg_only"}},
        }
        self.assertIsNone(_session_id(polluted))


class BestEffortSessionCaptureTests(unittest.TestCase):
    def test_best_effort_collect_sets_trace_id_from_xiaoo_stdout(self) -> None:
        from agent_fault_injection.pipeline.runner import ExperimentRunner
        from agent_fault_injection.pipeline.artifact_store import ArtifactStore
        from agent_fault_injection.platform_adapters.xiaoo.adapter import XiaoOAdapter
        from agent_fault_injection.fault_inject.catalog.registry import FaultRegistry
        from agent_fault_injection.pipeline.models import RunRequest

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            artifacts = _artifacts(root)
            artifacts.stdout_file.write_text(
                json.dumps(
                    {
                        "type": "session_start",
                        "data": {
                            "session_id": "c3ea1a83-eedc-4e75-a606-862962e5e9a1",
                            "agent": "defaultagent",
                        },
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            artifacts.events_file.write_text(
                json.dumps(
                    {
                        "schema_version": "1",
                        "run_id": artifacts.run_id,
                        "sequence": 1,
                        "kind": "fault.activation.completed",
                        "payload": {"skill": "thinking-dead-loop"},
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            store = ArtifactStore(root.parent / "out")
            request = RunRequest(
                platform="xiaoo",
                agent="defaultagent",
                fault="thinking-dead-loop",
                prompt="x",
                workspace=root,
                output_dir=root,
                run_id=artifacts.run_id,
            )
            fault = FaultRegistry().get("thinking-dead-loop")
            adapter = XiaoOAdapter()
            ExperimentRunner()._best_effort_collect(
                request=request,
                fault=fault,
                artifacts=artifacts,
                store=store,
                adapter=adapter,
            )
            # Trace ID lives in collect-result / interactions — not a fabricated
            # session.json join sidecar.
            self.assertFalse(artifacts.session_file.is_file())
            collect = json.loads(
                (artifacts.root / "collect-result.json").read_text(encoding="utf-8")
            )
            self.assertEqual(
                collect["taskId"], "c3ea1a83-eedc-4e75-a606-862962e5e9a1"
            )
            self.assertTrue(collect["sessionAligned"])
            self.assertTrue(collect["faultActivated"])

    def test_best_effort_collect_does_not_fake_fault_activated(self) -> None:
        from agent_fault_injection.pipeline.runner import ExperimentRunner
        from agent_fault_injection.pipeline.artifact_store import ArtifactStore
        from agent_fault_injection.platform_adapters.opencode.adapter import (
            OpenCodeAdapter,
        )
        from agent_fault_injection.fault_inject.catalog.registry import FaultRegistry
        from agent_fault_injection.pipeline.models import RunRequest

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            artifacts = _artifacts(root)
            # No events.jsonl — plugin never started.
            store = ArtifactStore(root.parent / "out")
            request = RunRequest(
                platform="opencode",
                agent="build",
                fault="thinking-dead-loop",
                prompt="use thinking-dead-loop",
                workspace=root,
                output_dir=root,
                run_id=artifacts.run_id,
            )
            fault = FaultRegistry().get("thinking-dead-loop")
            ExperimentRunner()._best_effort_collect(
                request=request,
                fault=fault,
                artifacts=artifacts,
                store=store,
                adapter=OpenCodeAdapter(),
            )
            collect = json.loads(
                (artifacts.root / "collect-result.json").read_text(encoding="utf-8")
            )
            self.assertFalse(collect["faultActivated"])
            self.assertIsNone(collect["taskId"])
            self.assertFalse(collect["sessionAligned"])

    def test_plugin_start_failed_never_promoted_to_completed(self) -> None:
        from agent_fault_injection.pipeline.runner import ExperimentRunner
        from agent_fault_injection.pipeline.exceptions import PluginStartupError
        from agent_fault_injection.pipeline.models import (
            RunStatus,
            TerminationReason,
        )

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            artifacts = _artifacts(root)
            # Even a stale/fake collect must not override plugin_start_failed.
            (artifacts.root / "collect-result.json").write_text(
                json.dumps(
                    {
                        "runId": artifacts.run_id,
                        "taskId": None,
                        "sessionAligned": False,
                        "faultActivated": True,
                    }
                ),
                encoding="utf-8",
            )
            store = type(
                "Store",
                (),
                {
                    "update_manifest": staticmethod(
                        lambda *args, **kwargs: None
                    )
                },
            )()
            recovered = ExperimentRunner()._completed_from_collect_if_activated(
                store=store,
                artifacts=artifacts,
                reason=TerminationReason.PLUGIN_START_FAILED,
                error=PluginStartupError("plugin not ready"),
            )
            self.assertIsNone(recovered)

            # Non-plugin failures may still recover when collect proves activation.
            recovered_ok = ExperimentRunner()._completed_from_collect_if_activated(
                store=store,
                artifacts=artifacts,
                reason=TerminationReason.PLATFORM_ERROR,
                error=RuntimeError("agent aborted after activation"),
            )
            self.assertIsNotNone(recovered_ok)
            assert recovered_ok is not None
            self.assertEqual(recovered_ok.status, RunStatus.COMPLETED)


if __name__ == "__main__":
    unittest.main()
