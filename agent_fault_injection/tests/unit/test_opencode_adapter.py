import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from unittest import TestCase
from unittest.mock import patch

from agent_fault_injection.fault_inject.injection.installer import InstallSession
from agent_fault_injection.fault_inject.catalog.registry import FaultRegistry
from agent_fault_injection.pipeline.models import RunArtifacts, RunRequest
from agent_fault_injection.platform_adapters.opencode.adapter import OpenCodeAdapter


class OpenCodeAdapterTests(TestCase):
    def test_builds_internal_platform_command(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request = RunRequest(
                platform="opencode",
                agent="build",
                fault="step-omission",
                prompt="fix tests",
                workspace=root,
                output_dir=root / "artifacts",
                platform_options={"auto": True, "model": "provider/model"},
            )
            artifacts = RunArtifacts(
                run_id="run-1",
                root=root,
                raw_dir=root / "raw",
                resolved_fault_dir=root / "resolved",
                events_file=root / "events",
                session_file=root / "session",
                stdout_file=root / "stdout",
                stderr_file=root / "stderr",
                trajectory_file=root / "trajectory",
                interactions_file=root / "interactions",
                execution_file=root / "execution.jsonl",
                manifest_file=root / "manifest",
                request_file=root / "request",
                plugin_ready_file=root / "ready",
            )

            command = OpenCodeAdapter._build_command(
                sys.executable,
                request,
                artifacts,
                supports_auto=True,
            )

            self.assertEqual(command[0:2], [sys.executable, "run"])
            self.assertIn("--agent", command)
            self.assertIn("--auto", command)
            self.assertIn("--print-logs", command)
            self.assertIn("provider/model", command)
            self.assertEqual(command[-1], "fix tests")

    def test_build_command_defaults_auto_when_unset(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request = RunRequest(
                platform="opencode",
                agent="build",
                fault="step-omission",
                prompt="fix tests",
                workspace=root,
                output_dir=root / "artifacts",
                platform_options={},
            )
            artifacts = RunArtifacts(
                run_id="run-1",
                root=root,
                raw_dir=root / "raw",
                resolved_fault_dir=root / "resolved",
                events_file=root / "events",
                session_file=root / "session",
                stdout_file=root / "stdout",
                stderr_file=root / "stderr",
                trajectory_file=root / "trajectory",
                interactions_file=root / "interactions",
                execution_file=root / "execution.jsonl",
                manifest_file=root / "manifest",
                request_file=root / "request",
                plugin_ready_file=root / "ready",
            )
            command = OpenCodeAdapter._build_command(
                sys.executable,
                request,
                artifacts,
                supports_auto=True,
            )
            self.assertIn("--auto", command)

    def test_build_command_omits_auto_when_disabled(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request = RunRequest(
                platform="opencode",
                agent="build",
                fault="step-omission",
                prompt="fix tests",
                workspace=root,
                output_dir=root / "artifacts",
                platform_options={"auto": False},
            )
            artifacts = RunArtifacts(
                run_id="run-1",
                root=root,
                raw_dir=root / "raw",
                resolved_fault_dir=root / "resolved",
                events_file=root / "events",
                session_file=root / "session",
                stdout_file=root / "stdout",
                stderr_file=root / "stderr",
                trajectory_file=root / "trajectory",
                interactions_file=root / "interactions",
                execution_file=root / "execution.jsonl",
                manifest_file=root / "manifest",
                request_file=root / "request",
                plugin_ready_file=root / "ready",
            )
            command = OpenCodeAdapter._build_command(
                sys.executable,
                request,
                artifacts,
                supports_auto=True,
            )
            self.assertNotIn("--auto", command)

    def test_build_command_omits_auto_when_cli_unsupported(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request = RunRequest(
                platform="opencode",
                agent="build",
                fault="step-omission",
                prompt="fix tests",
                workspace=root,
                output_dir=root / "artifacts",
                platform_options={"auto": True},
            )
            artifacts = RunArtifacts(
                run_id="run-1",
                root=root,
                raw_dir=root / "raw",
                resolved_fault_dir=root / "resolved",
                events_file=root / "events",
                session_file=root / "session",
                stdout_file=root / "stdout",
                stderr_file=root / "stderr",
                trajectory_file=root / "trajectory",
                interactions_file=root / "interactions",
                execution_file=root / "execution.jsonl",
                manifest_file=root / "manifest",
                request_file=root / "request",
                plugin_ready_file=root / "ready",
            )
            command = OpenCodeAdapter._build_command(
                sys.executable,
                request,
                artifacts,
                supports_auto=False,
            )
            self.assertNotIn("--auto", command)

    def test_resolves_configured_executable(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request = RunRequest(
                platform="opencode",
                agent="build",
                fault="step-omission",
                prompt="test",
                workspace=root,
                output_dir=root,
                platform_options={"executable": sys.executable},
            )

            self.assertEqual(
                Path(OpenCodeAdapter._resolve_executable(request)),
                Path(sys.executable).resolve(),
            )

    def test_runtime_env_keeps_system_and_overlays_agent_ras(self) -> None:
        with patch.dict(
            os.environ,
            {
                "PATH": "/usr/bin",
                "HOME": "/home/user",
            },
            clear=True,
        ):
            environment = OpenCodeAdapter.build_runtime_env(
                agent_ras={
                    "AGENT_RAS_RUN_ID": "run-1",
                    "AGENT_RAS_FAULT_SKILL": "step-omission",
                }
            )

            self.assertEqual(environment["AGENT_RAS_RUN_ID"], "run-1")
            self.assertEqual(environment["AGENT_RAS_FAULT_SKILL"], "step-omission")
            self.assertEqual(environment["HOME"], "/home/user")
            # Must not invent isolation knobs on top of the real env.
            self.assertNotIn("OPENCODE_CONFIG_DIR", environment)
            self.assertNotIn("OPENCODE_DB", environment)
            self.assertNotIn("OPENCODE_DISABLE_DEFAULT_PLUGINS", environment)

    def test_strip_agent_ras_env(self) -> None:
        cleaned = OpenCodeAdapter.strip_agent_ras_env(
            {
                "HOME": "/home/user",
                "AGENT_RAS_RUN_ID": "run-1",
                "AGENT_RAS_FAULT_SKILL": "step-omission",
                "PATH": "/usr/bin",
            }
        )
        self.assertEqual(cleaned, {"HOME": "/home/user", "PATH": "/usr/bin"})

    def test_parse_jsonc_strips_comments_and_trailing_commas(self) -> None:
        text = """
        {
          // line comment
          "provider": {
            "zhipuai": {
              "options": {
                "baseURL": "https://example.test/v1", /* inline */
              },
            },
          },
          "model": "zhipuai/glm-4",
        }
        """
        data = OpenCodeAdapter._parse_jsonc(text)
        self.assertEqual(
            data["provider"]["zhipuai"]["options"]["baseURL"],
            "https://example.test/v1",
        )
        self.assertEqual(data["model"], "zhipuai/glm-4")

    def test_load_user_opencode_config_prefers_jsonc(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            config_dir = home / ".config" / "opencode"
            config_dir.mkdir(parents=True)
            (config_dir / "opencode.jsonc").write_text(
                """
                {
                  // providers from interactive OpenCode
                  "provider": {
                    "zhipuai": {
                      "npm": "@ai-sdk/openai-compatible",
                      "options": {
                        "baseURL": "https://open.bigmodel.cn/api/paas/v4",
                      },
                    },
                  },
                }
                """,
                encoding="utf-8",
            )
            # Prefer jsonc over a stale json without baseURL.
            (config_dir / "opencode.json").write_text(
                json.dumps({"provider": {"zhipuai": {"options": {}}}}),
                encoding="utf-8",
            )

            with patch.object(Path, "home", return_value=home):
                config = OpenCodeAdapter._load_user_opencode_config()

            self.assertIsNotNone(config)
            assert config is not None
            self.assertEqual(
                config["provider"]["zhipuai"]["options"]["baseURL"],
                "https://open.bigmodel.cn/api/paas/v4",
            )

    def test_installs_and_cleans_up_fault_tools(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary)
            installation = InstallSession()
            fault = FaultRegistry().get("unverified-success")
            OpenCodeAdapter._install_fault_tools(
                installation=installation,
                fault=fault,
                workspace=workspace,
            )

            tool_dest = (
                workspace
                / ".agent-fault-injection"
                / "tools"
                / "ras-two-condition-test"
                / "condition_one_test.py"
            )
            self.assertTrue(tool_dest.is_file())

            installation.cleanup()

            self.assertFalse(tool_dest.exists())

    def test_install_fault_tools_overwrites_leftover_files(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary)
            fault = FaultRegistry().get("unverified-success")
            tool_dest = (
                workspace
                / ".agent-fault-injection"
                / "tools"
                / fault.skill_name
                / "condition_one_test.py"
            )
            tool_dest.parent.mkdir(parents=True)
            tool_dest.write_text("stale-tool\n", encoding="utf-8")

            installation = InstallSession()
            OpenCodeAdapter._install_fault_tools(
                installation=installation,
                fault=fault,
                workspace=workspace,
            )

            self.assertNotEqual(
                tool_dest.read_text(encoding="utf-8"),
                "stale-tool\n",
            )
            installation.cleanup()
            self.assertEqual(
                tool_dest.read_text(encoding="utf-8"),
                "stale-tool\n",
            )

    def test_installs_workspace_plugin_skill_and_lib(self) -> None:
        plugin_source = (
            Path(__file__).resolve().parents[2]
            / "platform_adapters"
            / "opencode"
            / "plugin"
            / "agent-fault-injection.ts"
        )
        rewrite_source = (
            Path(__file__).resolve().parents[2]
            / "platform_adapters"
            / "opencode"
            / "lib"
            / "rewrite-runtime.ts"
        )
        self.assertTrue(plugin_source.is_file())
        self.assertTrue(rewrite_source.is_file())

        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary)
            fault = FaultRegistry().get("step-order-error")
            installation = InstallSession()
            OpenCodeAdapter._install_workspace_plugin_and_skill(
                installation=installation,
                workspace=workspace,
                fault=fault,
                plugin_source=plugin_source,
            )

            plugins_dir = workspace / ".opencode" / "plugins"
            plugin_dest = plugins_dir / "agent-fault-injection.ts"
            skill_dest = (
                workspace / ".opencode" / "skills" / fault.skill_name / "SKILL.md"
            )
            lib_runtime = workspace / ".opencode" / "lib" / "rewrite-runtime.ts"
            self.assertTrue(plugin_dest.is_file())
            self.assertTrue(skill_dest.is_file())
            self.assertTrue(lib_runtime.is_file())
            self.assertEqual(
                sorted(p.name for p in plugins_dir.iterdir() if p.is_file()),
                ["agent-fault-injection.ts"],
            )
            self.assertFalse((plugins_dir / "rewrite-runtime.ts").exists())
            plugin_text = plugin_dest.read_text(encoding="utf-8")
            self.assertIn('from "../lib/rewrite-runtime"', plugin_text)
            self.assertEqual(
                skill_dest.read_text(encoding="utf-8"),
                fault.skill_file.read_text(encoding="utf-8"),
            )

            installation.cleanup()
            self.assertFalse(plugin_dest.exists())
            self.assertFalse(skill_dest.exists())
            self.assertFalse(lib_runtime.exists())

    def test_provider_retry_failure_uses_attempt_not_duplicate_count(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            events_file = Path(temporary) / "events.jsonl"
            retry = {
                "kind": "opencode.event",
                "payload": {
                    "type": "session.status",
                    "properties": {
                        "status": {
                            "type": "retry",
                            "attempt": 1,
                            "message": "Cannot connect",
                        }
                    },
                },
            }
            events_file.write_text(
                "\n".join([json.dumps(retry), json.dumps(retry)]) + "\n",
                encoding="utf-8",
            )

            self.assertIsNone(
                OpenCodeAdapter._provider_retry_failure(
                    events_file,
                    retry_limit=2,
                )
            )
            self.assertIn(
                "attempt 1: Cannot connect",
                OpenCodeAdapter._provider_retry_failure(
                    events_file,
                    retry_limit=1,
                ),
            )

    def test_is_database_locked_failure_reads_stderr(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "raw").mkdir(parents=True, exist_ok=True)
            stderr = root / "stderr.log"
            stderr.write_text(
                "Error: Unexpected error\ndatabase is locked\n", encoding="utf-8"
            )
            empty = root / "empty-stderr"
            empty.write_text("", encoding="utf-8")

            def make_artifacts(stderr_file: Path) -> RunArtifacts:
                return RunArtifacts(
                    run_id="run-lock",
                    root=root,
                    raw_dir=root / "raw",
                    resolved_fault_dir=root / "resolved",
                    events_file=root / "events",
                    session_file=root / "session",
                    stdout_file=root / "stdout",
                    stderr_file=stderr_file,
                    trajectory_file=root / "trajectory",
                    interactions_file=root / "interactions",
                    execution_file=root / "execution.jsonl",
                    manifest_file=root / "manifest",
                    request_file=root / "request",
                    plugin_ready_file=root / "ready",
                )

            self.assertTrue(
                OpenCodeAdapter._is_database_locked_failure(
                    "Platform exited before plugin initialization",
                    make_artifacts(stderr),
                )
            )
            self.assertFalse(
                OpenCodeAdapter._is_database_locked_failure(
                    "some other error",
                    make_artifacts(empty),
                )
            )

if __name__ == "__main__":
    unittest.main()
