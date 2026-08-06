import json
import tempfile
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from unittest import TestCase

from agent_fault_injection.cli import (
    _parser,
    _print_run_progress,
    _print_run_result,
    build_request,
)
from agent_fault_injection.pipeline.models import (
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
                    "--auto, --no-auto",
                    "--plugin-startup-timeout",
                    "--run-id",
                    "available names",
                    "server-side",
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
                rendered = output.getvalue()
                self.assertNotIn("--judge", rendered)
                for text in expected:
                    self.assertIn(text, rendered)

    def test_prints_agent_execution_report(self) -> None:
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

        rendered = output.getvalue()
        self.assertIn("Agent Execution", rendered)
        self.assertIn("ras-test", rendered)
        self.assertIn("thinking-dead-loop", rendered)
        self.assertIn("Execution Status  finished", rendered)
        self.assertIn("Fault Activated   yes", rendered)
        self.assertNotIn("Judge is evaluating", rendered)

    def test_prints_run_result(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            artifacts = _artifacts(root)
            artifacts.manifest_file.write_text("{}", encoding="utf-8")
            artifacts.trajectory_file.write_text("", encoding="utf-8")
            (artifacts.root / "collect-result.json").write_text(
                "{}", encoding="utf-8"
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
                _print_run_result(result)

            rendered = output.getvalue()
            self.assertIn("Experiment Result", rendered)
            self.assertIn("Overall Status    completed", rendered)
            self.assertIn(str(artifacts.root), rendered)

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
                            "plugin_startup_timeout": 90,
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
                    "--plugin-startup-timeout",
                    "180",
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
                request.platform_options["plugin_startup_timeout"],
                180.0,
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
