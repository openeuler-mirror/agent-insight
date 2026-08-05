import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from unittest import TestCase
from unittest.mock import patch

from agent_fault_injection.exceptions import ToolInstallationError
from agent_fault_injection.fault_inject.installer import InstallSession
from agent_fault_injection.fault_inject.registry import FaultRegistry
from agent_fault_injection.models import RunArtifacts, RunRequest
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

    def test_copy_user_providers_reads_jsonc(self) -> None:
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
                providers = OpenCodeAdapter._copy_user_providers()

            self.assertIsNotNone(providers)
            assert providers is not None
            self.assertEqual(
                providers["zhipuai"]["options"]["baseURL"],
                "https://open.bigmodel.cn/api/paas/v4",
            )

    def test_resolves_matching_plugin_version_from_opencode(self) -> None:
        completed = mock.Mock(
            returncode=0,
            stdout="1.18.9\n",
            stderr="",
        )
        with mock.patch(
            "agent_fault_injection.platform_adapters.opencode.adapter.subprocess.run",
            return_value=completed,
        ) as run:
            version = OpenCodeAdapter._resolve_plugin_version("/bin/opencode")

        self.assertEqual(version, "1.18.9")
        run.assert_called_once_with(
            ["/bin/opencode", "--version"],
            capture_output=True,
            text=True,
            check=False,
            timeout=10,
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

    def test_assert_fault_tools_installed_raises_when_missing(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary)
            fault = FaultRegistry().get("execution-goal-drift")
            with self.assertRaisesRegex(
                ToolInstallationError,
                "goal_state_tool.py",
            ):
                OpenCodeAdapter._assert_fault_tools_installed(
                    fault=fault,
                    workspace=workspace,
                )

    def test_assert_fault_tools_installed_ok_after_install(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary)
            fault = FaultRegistry().get("execution-goal-drift")
            installation = InstallSession()
            OpenCodeAdapter._install_fault_tools(
                installation=installation,
                fault=fault,
                workspace=workspace,
            )
            OpenCodeAdapter._assert_fault_tools_installed(
                fault=fault,
                workspace=workspace,
            )
            installation.cleanup()

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

    def test_isolated_environment_preserves_model_state_and_loads_plugin_once(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            workspace = root / "workspace"
            workspace.mkdir()
            plugin = workspace / "agent-fault-injection-source.ts"
            plugin.write_text("export default {}", encoding="utf-8")
            request = RunRequest(
                platform="opencode",
                agent="build",
                fault="step-order-error",
                prompt="run scene 1",
                workspace=workspace,
                output_dir=root / "artifacts",
            )
            fault = FaultRegistry().get("step-order-error")
            artifacts = RunArtifacts(
                run_id="run-isolated",
                root=root / "run",
                raw_dir=root / "run" / "raw",
                resolved_fault_dir=root / "run" / "resolved",
                events_file=root / "run" / "raw" / "events.jsonl",
                session_file=root / "run" / "raw" / "session.json",
                stdout_file=root / "run" / "raw" / "stdout.log",
                stderr_file=root / "run" / "raw" / "stderr.log",
                trajectory_file=root / "run" / "trajectory.jsonl",
                interactions_file=root / "run" / "interactions.json",
                execution_file=root / "run" / "execution.jsonl",
                manifest_file=root / "run" / "manifest.json",
                request_file=root / "run" / "request.json",
                plugin_ready_file=root / "run" / "raw" / "ready.json",
            )
            home = root / "home"
            config_dir = home / ".config" / "opencode"
            config_dir.mkdir(parents=True)
            provider = {
                "custom": {
                    "options": {"baseURL": "http://provider.example/v1"},
                    "models": {"UPPER": {"name": "UPPER"}},
                }
            }
            (config_dir / "opencode.jsonc").write_text(
                json.dumps(
                    {
                        "model": "custom/UPPER",
                        "small_model": "custom/UPPER",
                        "provider": provider,
                        "plugin": ["must-not-be-copied"],
                    }
                ),
                encoding="utf-8",
            )
            with mock.patch.object(Path, "home", return_value=home):
                isolated = OpenCodeAdapter._prepare_isolated_environment(
                    request=request,
                    artifacts=artifacts,
                    fault=fault,
                    plugin_source=plugin,
                    plugin_version="1.18.9",
                )
            try:
                config = json.loads(
                    (isolated / "config" / "opencode.json").read_text(
                        encoding="utf-8"
                    )
                )
                isolated_plugin = isolated / "config" / "plugins" / "agent-fault-injection.ts"
                self.assertEqual(config["plugin"], [str(isolated_plugin.resolve())])
                self.assertEqual(config["model"], "custom/UPPER")
                self.assertEqual(config["small_model"], "custom/UPPER")
                self.assertEqual(config["provider"], provider)
                self.assertEqual(
                    isolated_plugin.read_text(encoding="utf-8"),
                    "export default {}",
                )
                isolated_skill = (
                    isolated / "config" / "skills" / fault.skill_name / "SKILL.md"
                )
                self.assertEqual(
                    isolated_skill.read_text(encoding="utf-8"),
                    fault.skill_file.read_text(encoding="utf-8"),
                )
                package = json.loads(
                    (isolated / "config" / "package.json").read_text(encoding="utf-8")
                )
                self.assertEqual(
                    package["dependencies"]["@opencode-ai/plugin"],
                    "1.18.9",
                )
                with mock.patch.dict(
                    os.environ,
                    {
                        "HOME": "/real/home",
                        "XDG_DATA_HOME": "/real/data",
                        "OPENCODE_CONFIG_DIR": "/old/config",
                    },
                    clear=True,
                ):
                    environment = OpenCodeAdapter._build_environment(
                        artifacts=artifacts,
                        fault=fault,
                        isolated_root=isolated,
                    )
                self.assertEqual(environment["HOME"], "/real/home")
                self.assertEqual(environment["XDG_DATA_HOME"], "/real/data")
                self.assertEqual(
                    environment["OPENCODE_CONFIG_DIR"],
                    str(isolated / "config"),
                )
                self.assertEqual(
                    environment["AGENT_RAS_FAULT_SKILL"],
                    fault.skill_name,
                )
            finally:
                shutil.rmtree(isolated, ignore_errors=True)

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


if __name__ == "__main__":
    unittest.main()
