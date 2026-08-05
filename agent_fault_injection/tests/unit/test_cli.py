import json
import tempfile
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from unittest import TestCase

from agent_fault_injection.cli import (
    _parser,
    _print_judge_result,
    _print_run_progress,
    build_request,
)
from agent_fault_injection.models import (
    FaultContainmentStatus,
    FaultOutcome,
    RunArtifacts,
    RunRequest,
    RunResult,
    RunStatus,
    TerminationReason,
)


def _artifacts(root: Path) -> RunArtifacts:
    raw = root / "raw"
    raw.mkdir(parents=True)
    return RunArtifacts(
        run_id="ras-test",
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


class CliTests(TestCase):
    def test_all_cli_levels_explain_their_operations(self) -> None:
        cases = [
            (
                ["--help"],
                ["run --help", "fault --help"],
            ),
            (
                ["run", "--help"],
                [
                    "--judge, --no-judge",
                    "--auto, --no-auto",
                    "--plugin-startup-timeout",
                    "--run-id",
                    "available names",
                    "server-side judge",
                ],
            ),
            (
                ["fault", "--help"],
                ["fault list", "fault add --help"],
            ),
            (
                ["fault", "add", "--help"],
                ["--skill-file", "--description"],
            ),
            (
                ["fault", "list", "--help"],
                ["fault name", "injected skill name"],
            ),
        ]

        for arguments, expected in cases:
            with self.subTest(arguments=arguments):
                output = StringIO()
                with redirect_stdout(output), self.assertRaises(
                    SystemExit
                ) as raised:
                    _parser().parse_args(arguments)

                self.assertEqual(raised.exception.code, 0)
                for text in expected:
                    self.assertIn(text, output.getvalue())

    def test_prints_agent_report_then_judge_wait_message(self) -> None:
        output = StringIO()

        with redirect_stdout(output):
            _print_run_progress(
                "agent_execution_finished",
                {
                    "run_id": "ras-test",
                    "platform": "opencode",
                    "agent": "build",
                    "fault": "thinking-dead-loop",
                    "workspace": "/tmp/workspace",
                    "execution_status": "finished",
                    "termination_reason": TerminationReason.PROCESS_EXITED,
                    "exit_code": 0,
                    "fault_activated": True,
                    "trajectory": "/tmp/artifacts/trajectory.jsonl",
                    "artifacts": "/tmp/artifacts",
                },
            )
            _print_run_progress("fault_verification_started", {})

        rendered = output.getvalue()
        self.assertIn("Agent Execution", rendered)
        self.assertIn("ras-test", rendered)
        self.assertIn("thinking-dead-loop", rendered)
        self.assertIn("Execution Status  finished", rendered)
        self.assertIn("Fault Activated   yes", rendered)
        self.assertIn(
            "Judge is evaluating the collected execution data...",
            rendered,
        )

    def test_prints_completed_judge_result(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            artifacts = _artifacts(root)
            artifacts.manifest_file.write_text("{}", encoding="utf-8")
            artifacts.trajectory_file.write_text("", encoding="utf-8")
            request = RunRequest(
                platform="opencode",
                agent="build",
                fault="thinking-dead-loop",
                prompt="test",
                workspace=root,
                output_dir=root,
            )
            result = RunResult(
                run_id=artifacts.run_id,
                status=RunStatus.COMPLETED,
                termination_reason=TerminationReason.SESSION_ERROR,
                artifacts=artifacts,
                exit_code=1,
                fault_outcome=FaultOutcome.OCCURRED,
                fault_reason=(
                    "Repetitive reasoning was observed and then interrupted."
                ),
                fault_containment_status=(
                    FaultContainmentStatus.RECOVERED
                ),
            )
            output = StringIO()

            with redirect_stdout(output):
                _print_judge_result(request, result)

            rendered = output.getvalue()
            self.assertIn("Judge Result", rendered)
            self.assertIn("FAULT OCCURRED", rendered)
            self.assertIn("RECOVERED", rendered)
            self.assertIn("occurred + recovered", rendered)
            self.assertIn("Repetitive reasoning was observed", rendered)
            self.assertIn(str(artifacts.manifest_file), rendered)

    def test_prints_skipped_judge_result(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            artifacts = _artifacts(root)
            request = RunRequest(
                platform="opencode",
                agent="build",
                fault="step-omission",
                prompt="test",
                workspace=root,
                output_dir=root,
                platform_options={"judge_enabled": False},
            )
            result = RunResult(
                run_id=artifacts.run_id,
                status=RunStatus.COMPLETED,
                termination_reason=TerminationReason.SESSION_IDLE,
                artifacts=artifacts,
                exit_code=0,
            )
            output = StringIO()

            with redirect_stdout(output):
                _print_judge_result(request, result)

            rendered = output.getvalue()
            self.assertIn("Evaluation        skipped", rendered)
            self.assertIn("judge disabled", rendered)

    def test_parses_fault_add_command(self) -> None:
        namespace = _parser().parse_args(
            [
                "fault",
                "add",
                "--name",
                "tool-timeout",
                "--skill-file",
                "/tmp/tool-timeout/SKILL.md",
                "--description",
                "Repeated tool timeout fault",
            ]
        )

        self.assertEqual(namespace.command, "fault")
        self.assertEqual(namespace.fault_command, "add")
        self.assertEqual(namespace.name, "tool-timeout")
        self.assertEqual(namespace.description, "Repeated tool timeout fault")
        self.assertFalse(hasattr(namespace, "category"))

    def test_cli_values_override_config(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config = root / "experiment.json"
            config.write_text(
                json.dumps(
                    {
                        "platform": "opencode",
                        "agent": "plan",
                        "fault": "step-omission",
                        "prompt": "from config",
                        "workspace": str(root),
                        "output_dir": str(root / "artifacts"),
                        "platform_options": {
                            "judge_agent": "plan",
                            "judge_timeout_seconds": 90,
                        },
                    }
                ),
                encoding="utf-8",
            )
            namespace = _parser().parse_args(
                [
                    "run",
                    "--config",
                    str(config),
                    "--agent",
                    "build",
                    "--prompt",
                    "from cli",
                    "--judge-agent",
                    "build",
                    "--judge-model",
                    "judge/model",
                ]
            )

            request = build_request(namespace)

            self.assertEqual(request.agent, "build")
            self.assertEqual(request.prompt, "from cli")
            self.assertEqual(request.platform, "opencode")
            self.assertTrue(request.run_id)
            self.assertEqual(
                request.workspace.parent.parent.name, ".ras-runs"
            )
            self.assertEqual(request.workspace.parent.name, "single")
            self.assertNotEqual(request.workspace.resolve(), root.resolve())
            self.assertEqual(
                request.platform_options["judge_agent"],
                "build",
            )
            self.assertEqual(
                request.platform_options["judge_model"],
                "judge/model",
            )
            self.assertEqual(
                request.platform_options["judge_timeout_seconds"],
                90,
            )
            self.assertTrue(request.platform_options["auto"])

    def test_run_id_cli_override(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            namespace = _parser().parse_args(
                [
                    "run",
                    "--platform",
                    "opencode",
                    "--agent",
                    "build",
                    "--fault",
                    "step-omission",
                    "--prompt",
                    "exercise",
                    "--workspace",
                    str(root),
                    "--output-dir",
                    str(root / "artifacts"),
                    "--run-id",
                    "ras-insight-fixed-id",
                ]
            )
            request = build_request(namespace)
            self.assertEqual(request.run_id, "ras-insight-fixed-id")
            self.assertIn("ras-insight-fixed-id", request.workspace.name)

    def test_defaults_auto_true_when_unset(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            namespace = _parser().parse_args(
                [
                    "run",
                    "--platform",
                    "opencode",
                    "--agent",
                    "build",
                    "--fault",
                    "step-omission",
                    "--prompt",
                    "exercise",
                    "--workspace",
                    str(root),
                ]
            )
            request = build_request(namespace)
            self.assertTrue(request.platform_options["auto"])
            self.assertEqual(request.workspace.parent.name, "single")
            self.assertIn(request.run_id or "", request.workspace.name)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            namespace = _parser().parse_args(
                [
                    "run",
                    "--platform",
                    "opencode",
                    "--agent",
                    "build",
                    "--fault",
                    "step-omission",
                    "--prompt",
                    "exercise",
                    "--workspace",
                    str(root),
                    "--no-auto",
                ]
            )
            request = build_request(namespace)
            self.assertFalse(request.platform_options["auto"])

    def test_plugin_startup_timeout_cli_flag(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            namespace = _parser().parse_args(
                [
                    "run",
                    "--platform",
                    "opencode",
                    "--agent",
                    "build",
                    "--fault",
                    "step-omission",
                    "--prompt",
                    "exercise",
                    "--workspace",
                    str(root),
                    "--plugin-startup-timeout",
                    "180",
                ]
            )
            request = build_request(namespace)
            self.assertEqual(
                request.platform_options["plugin_startup_timeout"],
                180.0,
            )

    def test_loads_yaml_experiment_config(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config = root / "experiment.yaml"
            config.write_text(
                "\n".join(
                    [
                        "platform: opencode",
                        "agent: build",
                        "fault: step-omission",
                        "prompt: exercise the fault",
                        f"workspace: {root}",
                        f"output_dir: {root / 'artifacts'}",
                    ]
                ),
                encoding="utf-8",
            )

            namespace = _parser().parse_args(
                ["run", "--config", str(config)]
            )
            request = build_request(namespace)

            self.assertEqual(request.platform, "opencode")
            self.assertEqual(request.fault, "step-omission")
            self.assertNotEqual(request.workspace.resolve(), root.resolve())
            self.assertEqual(request.workspace.parent.parent.name, ".ras-runs")
            self.assertEqual(request.workspace.parent.name, "single")
            self.assertTrue(request.run_id)
            self.assertIn(request.run_id or "", request.workspace.name)
            self.assertTrue(request.platform_options["auto"])
