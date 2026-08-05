"""Tests for normalized execution.jsonl evidence path."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from agent_fault_injection.evaluation import ExecutionEvidenceBuilder, OpenCodeFaultJudge, ProcessCapture
from agent_fault_injection.artifact_store import ArtifactStore
from agent_fault_injection.fault_inject.registry import FaultRegistry
from agent_fault_injection.models import (
    FaultContainmentStatus,
    FaultOutcome,
    PlatformRunResult,
    RunArtifacts,
    RunRequest,
    TerminationReason,
)


def _artifacts(root: Path) -> RunArtifacts:
    raw = root / "raw"
    resolved = root / "resolved_fault"
    raw.mkdir(parents=True)
    resolved.mkdir()
    return RunArtifacts(
        run_id="run-test",
        root=root,
        raw_dir=raw,
        resolved_fault_dir=resolved,
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


class NormalizedExecutionEvidenceTests(unittest.TestCase):
    def test_prefers_execution_jsonl_over_stdout(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            artifacts = _artifacts(Path(temporary))
            artifacts.events_file.write_text(
                json.dumps(
                    {"kind": "fault.activation.completed", "recorded_at": 100}
                )
                + "\n",
                encoding="utf-8",
            )
            # Misleading stdout that must be ignored when execution.jsonl exists.
            artifacts.stdout_file.write_text(
                json.dumps(
                    {
                        "type": "text",
                        "timestamp": 110,
                        "part": {"messageID": "m1", "text": "from-stdout"},
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            artifacts.execution_file.write_text(
                "\n".join(
                    [
                        json.dumps(
                            {
                                "sequence": 1,
                                "timestamp": 110,
                                "type": "assistant",
                                "content": "from-normalized",
                            }
                        ),
                        json.dumps(
                            {
                                "sequence": 2,
                                "timestamp": 120,
                                "type": "tool",
                                "tool": "bash",
                                "arguments": {"cmd": "ls"},
                                "status": "completed",
                                "output": "ok",
                            }
                        ),
                        json.dumps(
                            {
                                "sequence": 3,
                                "timestamp": 130,
                                "type": "final_answer",
                                "content": "done",
                            }
                        ),
                    ]
                )
                + "\n",
                encoding="utf-8",
            )

            evidence = ExecutionEvidenceBuilder().build(artifacts)
            types = [row.get("type") for row in evidence.actual_execution]
            self.assertIn("assistant", types)
            self.assertIn("tool", types)
            contents = [
                row.get("content")
                for row in evidence.actual_execution
                if row.get("type") == "assistant"
            ]
            self.assertEqual(contents, ["from-normalized"])
            self.assertEqual(evidence.final_answer, "done")

    def test_falls_back_when_execution_file_missing(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            artifacts = _artifacts(Path(temporary))
            artifacts.events_file.write_text(
                json.dumps(
                    {"kind": "fault.activation.completed", "recorded_at": 50}
                )
                + "\n",
                encoding="utf-8",
            )
            artifacts.stdout_file.write_text(
                json.dumps(
                    {
                        "type": "text",
                        "timestamp": 60,
                        "part": {"messageID": "m1", "text": "fallback-text"},
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            evidence = ExecutionEvidenceBuilder().build(artifacts)
            contents = [
                row.get("content")
                for row in evidence.actual_execution
                if row.get("type") == "assistant"
            ]
            self.assertEqual(contents, ["fallback-text"])


class UniversalOpenCodeJudgeTests(unittest.IsolatedAsyncioTestCase):
    async def test_accepts_non_opencode_platform_with_normalized_evidence(self) -> None:
        async def fake_runner(command, cwd, environment, timeout_seconds):
            self.assertEqual(command[0], "opencode")
            return ProcessCapture(
                exit_code=0,
                stdout=json.dumps(
                    {
                        "outcome": "occurred",
                        "fault_containment_status": "recovered",
                        "reason": "fault then corrected",
                    }
                ),
                stderr="",
            )

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            artifacts = _artifacts(root / "run")
            fault = FaultRegistry().get("step-omission")
            (artifacts.resolved_fault_dir / "SKILL.md").write_text(
                fault.skill_file.read_text(encoding="utf-8"),
                encoding="utf-8",
            )
            artifacts.events_file.write_text(
                json.dumps(
                    {"kind": "fault.activation.completed", "recorded_at": 1}
                )
                + "\n",
                encoding="utf-8",
            )
            artifacts.execution_file.write_text(
                json.dumps(
                    {
                        "sequence": 1,
                        "timestamp": 2,
                        "type": "assistant",
                        "content": "skipped a required step",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            request = RunRequest(
                platform="xiaoo",
                agent="build",
                fault=fault.name,
                prompt="exercise the fault",
                workspace=root,
                output_dir=root,
                platform_options={"judge_timeout_seconds": 30},
            )
            result = await OpenCodeFaultJudge(command_runner=fake_runner).evaluate(
                request=request,
                fault=fault,
                artifacts=artifacts,
                platform_result=PlatformRunResult(
                    exit_code=0,
                    termination_reason=TerminationReason.PROCESS_EXITED,
                    fault_activated=True,
                ),
                store=ArtifactStore(root),
            )
            self.assertEqual(result.outcome, FaultOutcome.OCCURRED)
            self.assertEqual(
                result.fault_containment_status,
                FaultContainmentStatus.RECOVERED,
            )
