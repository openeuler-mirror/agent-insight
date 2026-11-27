# Copyright (c) 2026 Huawei Technologies Co., Ltd.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

import asyncio
import json
import textwrap
import time
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from unittest import TestCase
from unittest.mock import patch

from agent_fault_injection.fault_inject.injection.installer import InstallSession
from agent_fault_injection.fault_inject.catalog.definition import FaultRegistry
from agent_fault_injection.pipeline.exceptions import ExperimentTimeoutError, PluginStartupError
from agent_fault_injection.pipeline.artifact_store import ArtifactStore
from agent_fault_injection.pipeline.models import RunArtifacts, RunRequest
from agent_fault_injection.platform_adapters.lifecycle import AdapterRunContext
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
                fi_injection={
                    "AGENT_FI_RUN_ID": "run-1",
                    "AGENT_FI_FAULT_SKILL": "step-omission",
                }
            )

            self.assertEqual(environment["AGENT_FI_RUN_ID"], "run-1")
            self.assertEqual(environment["AGENT_FI_FAULT_SKILL"], "step-omission")
            self.assertEqual(environment["HOME"], "/home/user")
            # Must not invent isolation knobs on top of the real env.
            self.assertNotIn("OPENCODE_CONFIG_DIR", environment)
            self.assertNotIn("OPENCODE_DB", environment)
            self.assertNotIn("OPENCODE_DISABLE_DEFAULT_PLUGINS", environment)

    def test_strip_fi_injection_env(self) -> None:
        cleaned = OpenCodeAdapter.strip_fi_injection_env(
            {
                "HOME": "/home/user",
                "AGENT_FI_RUN_ID": "run-1",
                "AGENT_FI_FAULT_SKILL": "step-omission",
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
        lib_dir = (
            Path(__file__).resolve().parents[2]
            / "platform_adapters"
            / "opencode"
            / "lib"
        )
        rewrite_source = lib_dir / "rewrite-runtime.ts"
        provider_rewrite_source = lib_dir / "provider-tool-call-rewrite.ts"
        self.assertTrue(plugin_source.is_file())
        self.assertTrue(rewrite_source.is_file())
        self.assertTrue(provider_rewrite_source.is_file())

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
            lib_provider = (
                workspace / ".opencode" / "lib" / "provider-tool-call-rewrite.ts"
            )
            package_json = workspace / ".opencode" / "package.json"
            self.assertTrue(plugin_dest.is_file())
            self.assertTrue(skill_dest.is_file())
            self.assertTrue(lib_runtime.is_file())
            self.assertTrue(lib_provider.is_file())
            self.assertTrue(package_json.is_file())
            package_data = json.loads(package_json.read_text(encoding="utf-8"))
            self.assertIn(
                "@opencode-ai/plugin",
                package_data.get("dependencies", {}),
            )
            self.assertEqual(
                sorted(p.name for p in plugins_dir.iterdir() if p.is_file()),
                ["agent-fault-injection.ts"],
            )
            self.assertFalse((plugins_dir / "rewrite-runtime.ts").exists())
            plugin_text = plugin_dest.read_text(encoding="utf-8")
            self.assertIn('from "../lib/rewrite-runtime"', plugin_text)
            self.assertIn(
                'from "../lib/provider-tool-call-rewrite"',
                plugin_text,
            )
            self.assertEqual(
                skill_dest.read_text(encoding="utf-8"),
                fault.skill_file.read_text(encoding="utf-8"),
            )

            installation.cleanup()
            self.assertFalse(plugin_dest.exists())
            self.assertFalse(skill_dest.exists())
            self.assertFalse(lib_runtime.exists())
            self.assertFalse(lib_provider.exists())
            self.assertFalse(package_json.exists())

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

    def test_recognizes_structured_opencode_abort_as_fault_interception(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            raw = root / "raw"
            raw.mkdir()
            stdout = raw / "stdout.log"
            stdout.write_text(
                json.dumps(
                    {
                        "type": "error",
                        "sessionID": "ses_intercepted",
                        "error": {
                            "name": "MessageAbortedError",
                            "data": {"message": "Aborted"},
                        },
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            artifacts = RunArtifacts(
                run_id="run-intercepted",
                root=root,
                raw_dir=raw,
                resolved_fault_dir=root / "resolved",
                events_file=raw / "events.jsonl",
                stdout_file=stdout,
                stderr_file=raw / "stderr.log",
                trajectory_file=root / "trajectory",
                interactions_file=root / "interactions",
                execution_file=root / "execution.jsonl",
                manifest_file=root / "manifest",
                request_file=root / "request",
                plugin_ready_file=raw / "ready",
            )

            self.assertTrue(
                OpenCodeAdapter._was_fault_intercepted(
                    artifacts,
                    "ses_intercepted",
                )
            )
            self.assertFalse(
                OpenCodeAdapter._was_fault_intercepted(
                    artifacts,
                    "ses_other",
                )
            )

            stdout.write_text(
                json.dumps(
                    {
                        "type": "error",
                        "sessionID": "ses_intercepted",
                        "error": {
                            "name": "ProviderError",
                            "data": {"message": "500"},
                        },
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            self.assertFalse(
                OpenCodeAdapter._was_fault_intercepted(artifacts, "ses_intercepted")
            )

    def test_startup_failure_message_reports_empty_logs_and_plugin_gap(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            raw = root / "raw"
            raw.mkdir(parents=True, exist_ok=True)
            stdout = raw / "stdout.log"
            stderr = raw / "stderr.log"
            stdout.write_text("", encoding="utf-8")
            stderr.write_text("", encoding="utf-8")
            ready = raw / "plugin-ready.json"
            artifacts = RunArtifacts(
                run_id="run-diag",
                root=root,
                raw_dir=raw,
                resolved_fault_dir=root / "resolved",
                events_file=raw / "events.jsonl",
                stdout_file=stdout,
                stderr_file=stderr,
                trajectory_file=root / "trajectory",
                interactions_file=root / "interactions",
                execution_file=root / "execution.jsonl",
                manifest_file=root / "manifest",
                request_file=root / "request",
                plugin_ready_file=ready,
            )
            message = OpenCodeAdapter._startup_failure_message(
                exc=PluginStartupError(
                    "Platform plugin did not become ready within 120s"
                ),
                artifacts=artifacts,
                startup_timeout=120,
                process_exit_code=None,
                plugin_installed=False,
                agent_fi_raw_dir=str(raw),
                agent_fi_run_id="run-diag",
            )
            self.assertIn("plugin-ready=missing", message)
            self.assertIn("workspace-plugin=missing", message)
            self.assertIn("AGENT_FI=set", message)
            self.assertIn("process-exit=still-running-at-timeout", message)
            self.assertIn("stderr: empty(0B)", message)
            self.assertIn("stdout: empty(0B)", message)


if __name__ == "__main__":
    unittest.main()


class OpenCodeStartupRecoveryTests(unittest.IsolatedAsyncioTestCase):
    """Exercise real subprocess cleanup and retry before business execution."""

    async def exercise(self, scenario, *, retries=1, timeout=3):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            workspace = root / "workspace"
            plugin = workspace / ".opencode" / "plugins" / "agent-fault-injection.ts"
            plugin.parent.mkdir(parents=True)
            plugin.write_text("// fixture plugin", encoding="utf-8")
            request = RunRequest(
                platform="opencode", agent="build", fault="thinking-dead-loop",
                prompt="fixture", workspace=workspace, output_dir=root / "artifacts",
                timeout_seconds=timeout,
                platform_options={
                    "_resolved_executable": sys.executable,
                    "plugin_startup_timeout": 0.15,
                    "plugin_startup_retries": retries,
                    "database_lock_retries": 0,
                },
            )
            store = ArtifactStore(request.output_dir)
            artifacts = store.create(request)
            script = root / "platform.py"
            script.write_text(textwrap.dedent(r"""
                import json, os, sys, time
                from pathlib import Path
                raw = Path(os.environ["AGENT_FI_RAW_DIR"])
                attempts = raw / "attempts.jsonl"
                number = len(attempts.read_text().splitlines()) + 1 if attempts.exists() else 1
                with attempts.open("a") as out:
                    out.write(json.dumps({"pid": os.getpid(), "attempt": number}) + "\n")
                scenario = sys.argv[1]
                if scenario == "permanent":
                    print("invalid plugin configuration", file=sys.stderr, flush=True)
                    sys.exit(3)
                if scenario == "stdout":
                    print(json.dumps({"sessionID": "ses_existing"}), flush=True)
                    time.sleep(60)
                if scenario == "partial":
                    (raw / "events.jsonl").write_text(json.dumps({
                        "kind": "run.session.bound", "payload": {"sessionID": "ses_existing"}
                    }) + "\n")
                    time.sleep(60)
                if scenario == "always" or number == 1:
                    time.sleep(60)
                (raw / "plugin-ready.json").write_text(json.dumps({
                    "cachedModels": os.environ.get("OPENCODE_DISABLE_MODELS_FETCH")
                }))
                (raw / "events.jsonl").write_text(json.dumps({
                    "kind": "fault.activation.completed", "payload": {"sessionID": "ses_recovered"}
                }) + "\n")
                time.sleep(0.08)
            """), encoding="utf-8")
            cache = root / "cache" / "opencode" / "models.json"
            cache.parent.mkdir(parents=True)
            cache.write_text('{"fixture": {"models": {}}}', encoding="utf-8")
            context = AdapterRunContext(
                request=request, fault=FaultRegistry().get("thinking-dead-loop"),
                artifacts=artifacts, store=store, workspace=workspace,
            )
            environment = dict(os.environ)
            environment.update({
                "AGENT_FI_RAW_DIR": str(artifacts.raw_dir),
                "AGENT_FI_RUN_ID": artifacts.run_id,
                "XDG_CACHE_HOME": str(root / "cache"),
            })
            environment.pop("OPENCODE_DISABLE_MODELS_FETCH", None)
            adapter = OpenCodeAdapter()
            started = time.monotonic()
            result = None
            error = None
            with patch.object(adapter, "_build_command", return_value=[sys.executable, str(script), scenario]):
                try:
                    result = await adapter.run_platform_session(context, environment)
                except (PluginStartupError, ExperimentTimeoutError) as exc:
                    error = exc
            attempts = [json.loads(line) for line in (artifacts.raw_dir / "attempts.jsonl").read_text().splitlines()]
            for attempt in attempts:
                with self.assertRaises(ProcessLookupError):
                    os.kill(attempt["pid"], 0)
            manifest = json.loads(artifacts.manifest_file.read_text())
            ready = json.loads(artifacts.plugin_ready_file.read_text()) if artifacts.plugin_ready_file.exists() else {}
            return result, error, attempts, manifest, ready, time.monotonic() - started

    async def test_transient_startup_recovers_after_stopping_first_process(self):
        result, error, attempts, manifest, ready, _ = await self.exercise("recover")
        self.assertIsNone(error)
        self.assertEqual(result.session_id, "ses_recovered")
        self.assertTrue(result.fault_activated)
        self.assertEqual(len(attempts), 2)
        self.assertEqual(manifest["startup_attempt"], 2)
        self.assertEqual(ready["cachedModels"], "1")

    async def test_repeated_startup_timeout_is_bounded(self):
        _, error, attempts, manifest, _, _ = await self.exercise("always")
        self.assertIsInstance(error, PluginStartupError)
        self.assertEqual(len(attempts), 2)
        self.assertIn("did not become ready", manifest["startup_last_error"])
        self.assertIsNone(manifest["startup_retry_reason"])

    async def test_permanent_early_exit_is_not_retried(self):
        _, error, attempts, _, _, _ = await self.exercise("permanent")
        self.assertIsInstance(error, PluginStartupError)
        self.assertEqual(len(attempts), 1)
        self.assertIn("invalid plugin configuration", str(error))

    async def test_existing_business_session_is_never_replayed(self):
        _, error, attempts, _, _, _ = await self.exercise("partial")
        self.assertIsInstance(error, PluginStartupError)
        self.assertEqual(len(attempts), 1)

    async def test_stdout_evidence_also_blocks_automatic_replay(self):
        _, error, attempts, _, _, _ = await self.exercise("stdout")
        self.assertIsInstance(error, PluginStartupError)
        self.assertEqual(len(attempts), 1)

    async def test_zero_retries_does_not_restart(self):
        _, error, attempts, _, _, _ = await self.exercise("always", retries=0)
        self.assertIsInstance(error, PluginStartupError)
        self.assertEqual(len(attempts), 1)

    async def test_overall_budget_covers_backoff_and_startup(self):
        _, error, attempts, _, _, elapsed = await self.exercise("always", timeout=0.35)
        self.assertIsInstance(error, ExperimentTimeoutError)
        self.assertEqual(len(attempts), 1)
        self.assertLess(elapsed, 0.9)

    def test_cache_fallback_respects_overrides_and_validates_catalog(self):
        with tempfile.TemporaryDirectory() as temporary:
            environment = {"XDG_CACHE_HOME": temporary, "OPENCODE_DISABLE_MODELS_FETCH": "0"}
            self.assertEqual(OpenCodeAdapter._startup_retry_environment(environment), environment)
            environment.pop("OPENCODE_DISABLE_MODELS_FETCH")
            self.assertEqual(OpenCodeAdapter._startup_retry_environment(environment), environment)
            cache = Path(temporary) / "opencode" / "models.json"
            cache.parent.mkdir()
            cache.write_text("not json")
            self.assertEqual(OpenCodeAdapter._startup_retry_environment(environment), environment)
            cache.write_text("[]")
            self.assertEqual(OpenCodeAdapter._startup_retry_environment(environment), environment)
            cache.write_text("{}")
            self.assertEqual(OpenCodeAdapter._startup_retry_environment(environment), environment)
