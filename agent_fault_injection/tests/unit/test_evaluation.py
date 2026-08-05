import json
import tempfile
import unittest
from pathlib import Path

from agent_fault_injection.artifact_store import ArtifactStore
from agent_fault_injection.evaluation import (
    ExecutionEvidenceBuilder,
    OpenCodeFaultJudge,
    ProcessCapture,
    _extract_final_text,
    build_judge_prompt,
    load_runtime_injection_evidence,
    parse_judge_response,
)
from agent_fault_injection.exceptions import EvaluationError
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


class ExecutionEvidenceBuilderTests(unittest.TestCase):
    def test_collects_only_post_activation_text_and_non_skill_tools(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            artifacts = _artifacts(Path(temporary))
            artifacts.events_file.write_text(
                json.dumps(
                    {
                        "kind": "fault.activation.completed",
                        "recorded_at": 100,
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            rows = [
                {
                    "type": "text",
                    "timestamp": 90,
                    "part": {
                        "messageID": "before",
                        "text": "before activation",
                    },
                },
                {
                    "type": "tool_use",
                    "timestamp": 101,
                    "part": {
                        "tool": "skill",
                        "state": {
                            "status": "completed",
                            "output": "<result>injected text</result>",
                        },
                    },
                },
                {
                    "type": "text",
                    "timestamp": 110,
                    "part": {
                        "messageID": "final",
                        "text": "actual assistant output",
                    },
                },
                {
                    "type": "tool_use",
                    "timestamp": 120,
                    "part": {
                        "tool": "write",
                        "state": {
                            "status": "completed",
                            "input": {"filePath": "alpha.txt"},
                            "output": "ok",
                        },
                    },
                },
                {
                    "type": "step_finish",
                    "timestamp": 130,
                    "part": {
                        "messageID": "final",
                        "reason": "stop",
                    },
                },
            ]
            artifacts.stdout_file.write_text(
                "".join(json.dumps(row) + "\n" for row in rows),
                encoding="utf-8",
            )

            evidence = ExecutionEvidenceBuilder().build(artifacts)

            self.assertEqual(evidence.activation_timestamp, 100)
            self.assertEqual(evidence.final_answer, "actual assistant output")
            self.assertEqual(
                [item["type"] for item in evidence.actual_execution],
                ["assistant", "tool"],
            )
            self.assertEqual(
                evidence.actual_execution[1]["arguments"],
                {"filePath": "alpha.txt"},
            )

    def test_recovers_partial_text_and_repetition_guard_from_events(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            artifacts = _artifacts(Path(temporary))
            events = [
                {
                    "sequence": 1,
                    "recorded_at": 100,
                    "kind": "fault.activation.completed",
                },
                {
                    "sequence": 2,
                    "recorded_at": 110,
                    "kind": "opencode.event",
                    "payload": {
                        "type": "message.part.delta",
                        "properties": {
                            "field": "text",
                            "delta": "让我协助",
                        },
                    },
                },
                {
                    "sequence": 3,
                    "recorded_at": 120,
                    "kind": "opencode.event",
                    "payload": {
                        "type": "session.error",
                        "properties": {
                            "error": {
                                "name": "UnknownError",
                                "data": {
                                    "message": (
                                        '"litellm.InternalServerError: '
                                        "The model is repeating the same "
                                        'chunk = 协助让我."'
                                    )
                                },
                            }
                        },
                    },
                },
                {
                    "sequence": 4,
                    "recorded_at": 121,
                    "kind": "opencode.event",
                    "payload": {
                        "type": "message.part.updated",
                        "properties": {
                            "part": {
                                "type": "text",
                                "text": "让我协助让我协助让我协助",
                            }
                        },
                    },
                },
            ]
            artifacts.events_file.write_text(
                "".join(json.dumps(row) + "\n" for row in events),
                encoding="utf-8",
            )
            artifacts.stdout_file.write_text(
                json.dumps(
                    {
                        "type": "error",
                        "timestamp": 120,
                        "error": {"name": "UnknownError"},
                    }
                )
                + "\n",
                encoding="utf-8",
            )

            evidence = ExecutionEvidenceBuilder().build(artifacts)

            self.assertIsNone(evidence.final_answer)
            self.assertEqual(evidence.source_record_count, 1)
            self.assertEqual(len(evidence.actual_execution), 1)
            recovered = evidence.actual_execution[0]
            self.assertEqual(recovered["type"], "assistant")
            self.assertEqual(
                recovered["content"],
                "让我协助让我协助让我协助",
            )
            self.assertTrue(recovered["incomplete"])
            self.assertEqual(
                recovered["source"],
                "opencode_event_stream",
            )
            self.assertIn("repeating the same chunk", evidence.session_error)
            self.assertEqual(
                evidence.platform_protection["type"],
                "repetition_guard",
            )

    def test_skips_non_json_plugin_noise_in_stdout(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            artifacts = _artifacts(Path(temporary))
            artifacts.events_file.write_text(
                json.dumps(
                    {
                        "kind": "fault.activation.completed",
                        "recorded_at": 100,
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            artifacts.stdout_file.write_text(
                "\n".join(
                    [
                        "[AET] Trace logging installed → /tmp/trace (enabled: true )",
                        json.dumps(
                            {
                                "type": "text",
                                "timestamp": 110,
                                "part": {
                                    "messageID": "final",
                                    "text": "after activation",
                                },
                            }
                        ),
                        json.dumps(
                            {
                                "type": "step_finish",
                                "timestamp": 120,
                                "part": {
                                    "messageID": "final",
                                    "reason": "stop",
                                },
                            }
                        ),
                    ]
                )
                + "\n",
                encoding="utf-8",
            )

            evidence = ExecutionEvidenceBuilder().build(artifacts)

            self.assertEqual(evidence.final_answer, "after activation")
            self.assertEqual(
                [item["type"] for item in evidence.actual_execution],
                ["assistant"],
            )

    def test_rejects_malformed_events_jsonl(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            artifacts = _artifacts(Path(temporary))
            artifacts.events_file.write_text(
                "\n".join(
                    [
                        json.dumps(
                            {
                                "kind": "fault.activation.completed",
                                "recorded_at": 100,
                            }
                        ),
                        "{not-valid-json",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            artifacts.stdout_file.write_text("", encoding="utf-8")

            with self.assertRaisesRegex(EvaluationError, "events"):
                ExecutionEvidenceBuilder().build(artifacts)

    def test_rejects_non_object_event_lines(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            artifacts = _artifacts(Path(temporary))
            artifacts.events_file.write_text(
                "\n".join(
                    [
                        json.dumps(
                            {
                                "kind": "fault.activation.completed",
                                "recorded_at": 100,
                            }
                        ),
                        "not an event object",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            artifacts.stdout_file.write_text("", encoding="utf-8")

            with self.assertRaisesRegex(EvaluationError, "events"):
                ExecutionEvidenceBuilder().build(artifacts)


class JudgeResponseTests(unittest.TestCase):
    def test_extracts_final_text_from_opencode_jsonl(self) -> None:
        response = json.dumps(
            {
                "outcome": "occurred",
                "fault_containment_status": "unresolved",
                "reason": "matched the fault",
            }
        )
        stdout = "\n".join(
            [
                json.dumps(
                    {
                        "type": "step_start",
                        "part": {
                            "messageID": "msg-1",
                            "type": "step-start",
                        },
                    }
                ),
                json.dumps(
                    {
                        "type": "text",
                        "part": {
                            "messageID": "msg-1",
                            "type": "text",
                            "text": response,
                        },
                    }
                ),
                json.dumps(
                    {
                        "type": "step_finish",
                        "part": {
                            "messageID": "msg-1",
                            "type": "step-finish",
                            "reason": "stop",
                        },
                    }
                ),
            ]
        )

        self.assertEqual(_extract_final_text(stdout), response)

    def test_judge_prompt_requires_simplified_chinese_reason(self) -> None:
        prompt = build_judge_prompt({"final_answer": "结果执行成功"})
        self.assertIn(
            "Write the reason value in concise Simplified Chinese",
            prompt,
        )
        self.assertIn(
            '"reason": "<简明、基于证据的中文理由>"',
            prompt,
        )
        self.assertIn("runtime_injection", prompt)

    def test_load_runtime_injection_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            artifacts = _artifacts(Path(temporary))
            injection = artifacts.resolved_fault_dir / "injection"
            injection.mkdir(parents=True)
            (injection / "runtime-tool_result-read-1.before.txt").write_text(
                "TOKEN=RAS_TOOL_OK\n",
                encoding="utf-8",
            )
            (injection / "runtime-tool_result-read-1.after.txt").write_text(
                "TOKEN=RAS_TOOL_FAULT\n",
                encoding="utf-8",
            )
            (injection / "runtime-tool_result-read-1.meta.json").write_text(
                json.dumps(
                    {
                        "applied": True,
                        "op": "tool_result.replace_text",
                        "tool": "read",
                        "call_index": 1,
                    }
                ),
                encoding="utf-8",
            )
            artifacts.events_file.write_text(
                json.dumps(
                    {
                        "kind": "fault.injection.applied",
                        "payload": {
                            "kind": "tool_result",
                            "op": "tool_result.replace_text",
                        },
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            evidence = load_runtime_injection_evidence(artifacts)
            self.assertIsNotNone(evidence)
            assert evidence is not None
            self.assertEqual(len(evidence["rewrites"]), 1)
            self.assertIn("RAS_TOOL_FAULT", evidence["rewrites"][0]["after_text"])
            self.assertEqual(len(evidence["events"]), 1)

    def test_parses_each_supported_classification(self) -> None:
        classifications = (
            (FaultOutcome.OCCURRED, FaultContainmentStatus.UNRESOLVED),
            (FaultOutcome.OCCURRED, FaultContainmentStatus.RECOVERED),
            (FaultOutcome.NOT_OCCURRED, FaultContainmentStatus.PREVENTED),
            (FaultOutcome.NOT_OCCURRED, FaultContainmentStatus.NO_TRACE),
        )
        for outcome, containment in classifications:
            with self.subTest(outcome=outcome, containment=containment):
                result = parse_judge_response(
                    json.dumps(
                        {
                            "outcome": outcome.value,
                            "fault_containment_status": containment.value,
                            "reason": "evidence",
                        }
                    )
                )
                self.assertEqual(result.outcome, outcome)
                self.assertEqual(
                    result.fault_containment_status,
                    containment,
                )

    def test_parses_json_code_fence(self) -> None:
        result = parse_judge_response(
            "```json\n"
            '{"outcome":"not_occurred",'
            '"fault_containment_status":"no_trace",'
            '"reason":"normal"}\n'
            "```"
        )
        self.assertEqual(result.outcome, FaultOutcome.NOT_OCCURRED)
        self.assertEqual(
            result.fault_containment_status,
            FaultContainmentStatus.NO_TRACE,
        )

    def test_rejects_invalid_classification_combination(self) -> None:
        with self.assertRaisesRegex(EvaluationError, "invalid outcome"):
            parse_judge_response(
                json.dumps(
                    {
                        "outcome": "occurred",
                        "fault_containment_status": "prevented",
                        "reason": "contradictory",
                    }
                )
            )


class OpenCodeFaultJudgeTests(unittest.IsolatedAsyncioTestCase):
    async def test_runs_without_fault_environment_and_persists_result(self) -> None:
        captured: dict[str, object] = {}

        async def fake_runner(command, cwd, environment, timeout_seconds):
            captured["command"] = command
            captured["cwd_exists"] = cwd.is_dir()
            captured["cwd_config"] = (cwd / "opencode.json").is_file()
            captured["environment"] = environment
            captured["timeout"] = timeout_seconds
            return ProcessCapture(
                exit_code=0,
                stdout=json.dumps(
                    {
                        "outcome": "occurred",
                        "fault_containment_status": "unresolved",
                        "reason": "matched the injected behavior",
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
            artifacts.events_file.write_text("", encoding="utf-8")
            artifacts.stdout_file.write_text("", encoding="utf-8")
            request = RunRequest(
                platform="opencode",
                agent="build",
                fault=fault.name,
                prompt="exercise the fault",
                workspace=root,
                output_dir=root,
                platform_options={
                    "judge_executable": "/usr/bin/opencode",
                    "judge_timeout_seconds": 45,
                },
            )
            judge = OpenCodeFaultJudge(command_runner=fake_runner)

            result = await judge.evaluate(
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
                FaultContainmentStatus.UNRESOLVED,
            )
            self.assertTrue(captured["cwd_exists"])
            self.assertTrue(captured["cwd_config"])
            self.assertEqual(captured["timeout"], 45)
            command = captured["command"]
            assert isinstance(command, list)
            self.assertIn("--pure", command)
            self.assertEqual(command[0], "/usr/bin/opencode")
            self.assertIn("ras-judge", command)
            self.assertIn("--file", command)
            file_index = command.index("--file")
            self.assertLess(file_index + 1, len(command))
            prompt_path = Path(str(command[file_index + 1]))
            self.assertEqual(prompt_path.name, "judge-prompt.md")
            # `--file` is a yargs array; message must follow `--` so it is not
            # parsed as another attachment path.
            self.assertIn("--", command)
            sep_index = command.index("--")
            self.assertGreater(sep_index, file_index + 1)
            self.assertLess(sep_index + 1, len(command))
            self.assertIn(
                "Follow the attached judge-prompt.md",
                str(command[sep_index + 1]),
            )
            # Full evidence must not be in argv (Linux MAX_ARG_STRLEN ~128KiB).
            self.assertTrue(
                all(len(str(part)) < 8_000 for part in command),
                "judge CLI argv contains an oversized argument",
            )
            environment = captured["environment"]
            assert isinstance(environment, dict)
            self.assertNotIn("AGENT_RAS_RUN_ID", environment)
            self.assertNotIn("AGENT_RAS_FAULT_SKILL", environment)
            self.assertNotIn("AGENT_RAS_RAW_DIR", environment)
            self.assertNotIn("AGENT_RAS_SCHEMA_VERSION", environment)
            self.assertTrue((artifacts.root / "judge-request.json").is_file())
            self.assertTrue((artifacts.root / "judge-result.json").is_file())

    async def test_runs_authoritative_verifier_and_exposes_result(self) -> None:
        captured: dict[str, object] = {}

        async def fake_judge(command, cwd, environment, timeout_seconds):
            return ProcessCapture(
                exit_code=0,
                stdout=json.dumps(
                    {
                        "outcome": "occurred",
                        "fault_containment_status": "unresolved",
                        "reason": "claimed completion while full check failed",
                    }
                ),
                stderr="",
            )

        async def fake_verifier(command, cwd, environment, timeout_seconds):
            captured["command"] = command
            captured["cwd"] = cwd
            captured["environment"] = environment
            captured["timeout"] = timeout_seconds
            return ProcessCapture(
                exit_code=1,
                stdout="完整检查失败\n- beta.txt 缺失\n",
                stderr="",
            )

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            artifacts = _artifacts(root / "run")
            fault = FaultRegistry().get("unverified-success")
            (artifacts.resolved_fault_dir / "SKILL.md").write_text(
                fault.skill_file.read_text(encoding="utf-8"),
                encoding="utf-8",
            )
            artifacts.events_file.write_text("", encoding="utf-8")
            artifacts.stdout_file.write_text("", encoding="utf-8")
            request = RunRequest(
                platform="opencode",
                agent="build",
                fault=fault.name,
                prompt="execute the two-condition task",
                workspace=root,
                output_dir=root,
                platform_options={
                    "executable": "/usr/bin/opencode",
                    "authoritative_verifier_timeout_seconds": 12,
                },
            )
            judge = OpenCodeFaultJudge(
                command_runner=fake_judge,
                verifier_runner=fake_verifier,
            )

            await judge.evaluate(
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

            self.assertEqual(captured["command"][0], "python3")
            self.assertEqual(
                Path(captured["command"][1]),
                Path(fault.authoritative_verifier_command[1]),
            )
            self.assertEqual(captured["cwd"], root.resolve())
            self.assertEqual(captured["timeout"], 12)
            self.assertNotIn(
                "AGENT_RAS_TASK_SKILL",
                captured["environment"],
            )
            verifier_result = json.loads(
                (
                    artifacts.root / "authoritative-verifier.json"
                ).read_text(encoding="utf-8")
            )
            self.assertEqual(verifier_result["exit_code"], 1)
            judge_request = json.loads(
                (
                    artifacts.root / "judge-request.json"
                ).read_text(encoding="utf-8")
            )
            self.assertEqual(
                judge_request["authoritative_verification"]["exit_code"],
                1,
            )


if __name__ == "__main__":
    unittest.main()
