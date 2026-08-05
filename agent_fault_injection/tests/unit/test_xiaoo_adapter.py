"""Unit tests for xiaoO adapter helpers."""

from __future__ import annotations

import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from agent_fault_injection.fault_inject.registry import FaultRegistry
from agent_fault_injection.models import RunArtifacts, RunRequest
from agent_fault_injection.platform_adapters.registry import PlatformAdapterRegistry
from agent_fault_injection.platform_adapters.xiaoo import XiaoOAdapter
from agent_fault_injection.platform_adapters.xiaoo import config_overlay
from agent_fault_injection.platform_adapters.xiaoo.hooker import ras_eval_hook
from agent_fault_injection.platform_adapters.xiaoo.mapper import XiaoOTrajectoryMapper


def _artifacts(root: Path) -> RunArtifacts:
    raw = root / "raw"
    resolved = root / "resolved_fault"
    raw.mkdir(parents=True)
    resolved.mkdir(parents=True, exist_ok=True)
    return RunArtifacts(
        run_id="run-xiaoo",
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


class XiaoORegistryTests(unittest.TestCase):
    def test_builtins_include_xiaoo(self) -> None:
        registry = PlatformAdapterRegistry()
        self.assertIn("xiaoo", registry.names())
        self.assertIn("opencode", registry.names())
        adapter = registry.get("xiaoo")
        self.assertIsInstance(adapter, XiaoOAdapter)
        self.assertEqual(adapter.name, "xiaoo")


class XiaoOConfigOverlayTests(unittest.TestCase):
    def test_prepare_overlay_rewrites_plugin_command(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            user_cfg = root / "user.toml"
            user_cfg.write_text(
                '[llm]\nprovider = "openai-compatible"\nmodel = "demo"\n'
                'api_key_env = "OPENAI_API_KEY"\n',
                encoding="utf-8",
            )
            config_toml, plugin_json = config_overlay.prepare_overlay(
                overlay_root=root / "overlay",
                user_config_path=user_cfg,
                model_override="override-model",
            )
            self.assertTrue(config_toml.is_file())
            text = config_toml.read_text(encoding="utf-8")
            self.assertIn('model = "override-model"', text)
            self.assertIn("[hooker]", text)
            self.assertIn(str(plugin_json.resolve()), text)
            entries = json.loads(plugin_json.read_text(encoding="utf-8"))
            self.assertEqual(len(entries), 2)
            for item in entries:
                self.assertIn("ras_eval_hook.py", item["command"])
                self.assertTrue(item["command"].startswith("python3 "))

    def test_prepare_overlay_can_enable_chat_llm_hooks(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            _config, plugin_json = config_overlay.prepare_overlay(
                overlay_root=root / "overlay",
                enable_chat_llm_hooks=True,
            )
            entries = json.loads(plugin_json.read_text(encoding="utf-8"))
            points = {item["hook_point"] for item in entries}
            self.assertIn("*.Chat.system.transform", points)
            self.assertIn("*.Llm.complete.pre", points)
            self.assertIn("*.Llm.complete.post", points)


class XiaoOHookerTests(unittest.TestCase):
    def test_noop_without_agent_ras_env(self) -> None:
        stdin = json.dumps(
            {"stage": "system_transform", "system": ["base"]}
        )
        with patch.dict(os.environ, {}, clear=True):
            with patch("sys.stdin", io.StringIO(stdin)):
                with patch("sys.stdout", new_callable=io.StringIO) as stdout:
                    code = ras_eval_hook.main()
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(stdout.getvalue()), {"result": "allow"})

    def test_system_transform_injects_and_marks_ready(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            raw = Path(temporary)
            ready = raw / "plugin-ready.json"
            env = {
                "AGENT_RAS_RUN_ID": "run-1",
                "AGENT_RAS_FAULT_SKILL": "ras-step-omission",
                "AGENT_RAS_RAW_DIR": str(raw),
                "AGENT_RAS_PLUGIN_READY": str(ready),
            }
            stdin = json.dumps(
                {
                    "stage": "system_transform",
                    "system": ["base"],
                }
            )
            with patch.dict(os.environ, env, clear=True):
                with patch("sys.stdin", io.StringIO(stdin)):
                    with patch("sys.stdout", new_callable=io.StringIO) as stdout:
                        code = ras_eval_hook.main()
            self.assertEqual(code, 0)
            result = json.loads(stdout.getvalue())
            self.assertEqual(result["result"], "transform")
            self.assertTrue(
                any("ras-step-omission" in part for part in result["system"])
            )
            self.assertTrue(ready.is_file())
            events = (raw / "events.jsonl").read_text(encoding="utf-8")
            self.assertIn("fault.activation.started", events)

    def test_tool_post_activates_on_skill_success(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            raw = Path(temporary)
            env = {
                "AGENT_RAS_RUN_ID": "run-1",
                "AGENT_RAS_FAULT_SKILL": "ras-step-omission",
                "AGENT_RAS_RAW_DIR": str(raw),
            }
            stdin = json.dumps(
                {
                    "stage": "post",
                    "call": {
                        "tool_name": "skill",
                        "input": {"skill": "ras-step-omission"},
                    },
                    "outcome": {"type": "success", "output": "loaded"},
                }
            )
            with patch.dict(os.environ, env, clear=True):
                with patch("sys.stdin", io.StringIO(stdin)):
                    with patch("sys.stdout", new_callable=io.StringIO) as stdout:
                        code = ras_eval_hook.main()
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(stdout.getvalue()), {"result": "accept"})
            events = (raw / "events.jsonl").read_text(encoding="utf-8")
            self.assertIn("fault.activation.completed", events)
            self.assertTrue((raw / "fault-activated.json").is_file())

    def test_tool_post_rewrites_matching_tool_result(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            raw = Path(temporary)
            artifacts = Path(temporary) / "injection"
            plan = [
                {
                    "op": "tool_result.replace_text",
                    "when": {"tool": "read|file_read", "call_index": 1},
                    "args": {"from": "RAS_TOOL_OK", "to": "RAS_TOOL_FAULT"},
                }
            ]
            env = {
                "AGENT_RAS_RUN_ID": "run-1",
                "AGENT_RAS_FAULT_SKILL": "ras-tool-result-corruption",
                "AGENT_RAS_RAW_DIR": str(raw),
                "AGENT_RAS_INJECTION_RUNTIME": json.dumps(plan),
                "AGENT_RAS_INJECTION_ARTIFACTS": str(artifacts),
            }
            # Activate first so rewrite path is exercised after skill gate.
            (raw / "fault-activated.json").write_text("{}", encoding="utf-8")
            stdin = json.dumps(
                {
                    "stage": "post",
                    "call": {
                        "tool_name": "read",
                        "input": {"filePath": "probe.txt"},
                    },
                    "outcome": {
                        "type": "success",
                        "output": "TOKEN=RAS_TOOL_OK\n",
                    },
                }
            )
            with patch.dict(os.environ, env, clear=True):
                with patch("sys.stdin", io.StringIO(stdin)):
                    with patch("sys.stdout", new_callable=io.StringIO) as stdout:
                        code = ras_eval_hook.main()
            self.assertEqual(code, 0)
            result = json.loads(stdout.getvalue())
            self.assertEqual(result["result"], "transform")
            self.assertEqual(result["modified_output"], "TOKEN=RAS_TOOL_FAULT\n")
            events = (raw / "events.jsonl").read_text(encoding="utf-8")
            self.assertIn("fault.injection.applied", events)
            before = artifacts / "runtime-tool_result-read-1.before.txt"
            after = artifacts / "runtime-tool_result-read-1.after.txt"
            self.assertTrue(before.is_file())
            self.assertTrue(after.is_file())
            self.assertIn("RAS_TOOL_OK", before.read_text(encoding="utf-8"))
            self.assertIn("RAS_TOOL_FAULT", after.read_text(encoding="utf-8"))

    def test_llm_pre_allows_and_records(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            raw = Path(temporary)
            env = {
                "AGENT_RAS_RUN_ID": "run-1",
                "AGENT_RAS_FAULT_SKILL": "ras-tool-result-corruption",
                "AGENT_RAS_RAW_DIR": str(raw),
            }
            stdin = json.dumps(
                {
                    "stage": "pre",
                    "hooker": {"hook_point": "*.Llm.complete.pre"},
                    "request": {"messages": []},
                }
            )
            with patch.dict(os.environ, env, clear=True):
                with patch("sys.stdin", io.StringIO(stdin)):
                    with patch("sys.stdout", new_callable=io.StringIO) as stdout:
                        code = ras_eval_hook.main()
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(stdout.getvalue()), {"result": "allow"})
            events = (raw / "events.jsonl").read_text(encoding="utf-8")
            self.assertIn("llm.pre", events)

    def test_tool_pre_denies_until_skill_activated(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            raw = Path(temporary)
            env = {
                "AGENT_RAS_RUN_ID": "run-1",
                "AGENT_RAS_FAULT_SKILL": "ras-step-omission",
                "AGENT_RAS_RAW_DIR": str(raw),
            }
            stdin = json.dumps(
                {
                    "stage": "pre",
                    "call": {
                        "tool_name": "bash",
                        "input": {"command": "ls"},
                    },
                }
            )
            with patch.dict(os.environ, env, clear=True):
                with patch("sys.stdin", io.StringIO(stdin)):
                    with patch("sys.stdout", new_callable=io.StringIO) as stdout:
                        code = ras_eval_hook.main()
            self.assertEqual(code, 0)
            result = json.loads(stdout.getvalue())
            self.assertEqual(result["result"], "deny")
            self.assertIn("ras-step-omission", result["reason"])
            events = (raw / "events.jsonl").read_text(encoding="utf-8")
            self.assertIn("fault.activation.started", events)

    def test_tool_pre_allows_matching_skill_call(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            raw = Path(temporary)
            env = {
                "AGENT_RAS_RUN_ID": "run-1",
                "AGENT_RAS_FAULT_SKILL": "ras-step-omission",
                "AGENT_RAS_RAW_DIR": str(raw),
            }
            stdin = json.dumps(
                {
                    "stage": "pre",
                    "call": {
                        "tool_name": "skill",
                        "input": {"skill": "ras-step-omission"},
                    },
                }
            )
            with patch.dict(os.environ, env, clear=True):
                with patch("sys.stdin", io.StringIO(stdin)):
                    with patch("sys.stdout", new_callable=io.StringIO) as stdout:
                        code = ras_eval_hook.main()
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(stdout.getvalue()), {"result": "allow"})


class XiaoOMapperTests(unittest.TestCase):
    def test_map_writes_trajectory_and_execution(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            artifacts = _artifacts(root)
            fault = FaultRegistry().get("step-omission")
            events = [
                {
                    "schema_version": "1",
                    "run_id": artifacts.run_id,
                    "sequence": 1,
                    "recorded_at": 10,
                    "kind": "fault.activation.completed",
                    "payload": {"skill": fault.skill_name},
                },
                {
                    "schema_version": "1",
                    "run_id": artifacts.run_id,
                    "sequence": 2,
                    "recorded_at": 20,
                    "kind": "xiaoo.event",
                    "payload": {
                        "type": "tool.post",
                        "tool": "bash",
                        "input": {"command": "ls"},
                        "outcome": {"type": "success", "output": "ok"},
                    },
                },
                {
                    "schema_version": "1",
                    "run_id": artifacts.run_id,
                    "sequence": 3,
                    "recorded_at": 30,
                    "kind": "xiaoo.cli",
                    "payload": {
                        "type": "response",
                        "data": {
                            "raw_reply": "done",
                            "session_id": "sess-1",
                        },
                    },
                },
            ]
            artifacts.events_file.write_text(
                "\n".join(json.dumps(row) for row in events) + "\n",
                encoding="utf-8",
            )
            request = RunRequest(
                platform="xiaoo",
                agent="defaultagent",
                fault=fault.name,
                prompt="task",
                workspace=root,
                output_dir=root,
            )
            summary = XiaoOTrajectoryMapper().map(request, fault, artifacts)
            self.assertTrue(summary.fault_activated)
            self.assertEqual(summary.session_id, "sess-1")
            self.assertTrue(artifacts.trajectory_file.is_file())
            self.assertTrue(artifacts.execution_file.is_file())
            exec_rows = [
                json.loads(line)
                for line in artifacts.execution_file.read_text(
                    encoding="utf-8"
                ).splitlines()
                if line.strip()
            ]
            types = [row["type"] for row in exec_rows]
            self.assertIn("tool", types)
            self.assertIn("final_answer", types)


class XiaoOAdapterUnitTests(unittest.TestCase):
    def test_health_and_catalog(self) -> None:
        adapter = XiaoOAdapter()
        health = adapter.health_check()
        self.assertIn("ready", health)
        self.assertIn("errors", health)
        agents = adapter.list_agents()
        self.assertEqual(agents["default"], "defaultagent")
        self.assertTrue(agents["agents"])

    def test_build_cli_command_uses_cli_prefix_and_format_when_supported(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            artifacts = _artifacts(root)
            fault = FaultRegistry().get("step-omission")
            request = RunRequest(
                platform="xiaoo",
                agent="defaultagent",
                fault=fault.name,
                prompt="task",
                workspace=root,
                output_dir=root,
                platform_options={"max_turns": 12},
            )
            config = root / "config.toml"
            config.write_text("[llm]\nmodel = \"demo\"\n", encoding="utf-8")
            with (
                patch.object(
                    XiaoOAdapter,
                    "_requires_cli_prefix",
                    return_value=True,
                ),
                patch.object(
                    XiaoOAdapter,
                    "_run_supports_flag",
                    side_effect=lambda _exe, flag, use_cli_prefix: flag
                    in {"--format", "--title", "--agent"},
                ),
            ):
                command = XiaoOAdapter._build_cli_command(
                    executable="xiaoo",
                    request=request,
                    artifacts=artifacts,
                    cli_model="Minimax-M2.7-highspeed",
                    config_toml=config,
                    fault=fault,
                )
            self.assertEqual(command[:3], ["xiaoo", "--cli", "run"])
            self.assertIn("--format", command)
            self.assertEqual(command[command.index("--format") + 1], "json")
            self.assertIn("--title", command)
            self.assertIn("--agent", command)
            self.assertIn("--max-turns", command)
            self.assertIn("--system", command)
            self.assertIn("-p", command)

    def test_build_cli_command_omits_cli_prefix_for_legacy_binary(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            artifacts = _artifacts(root)
            fault = FaultRegistry().get("step-omission")
            request = RunRequest(
                platform="xiaoo",
                agent="defaultagent",
                fault=fault.name,
                prompt="task",
                workspace=root,
                output_dir=root,
            )
            config = root / "config.toml"
            config.write_text("[llm]\nmodel = \"demo\"\n", encoding="utf-8")
            with (
                patch.object(
                    XiaoOAdapter,
                    "_requires_cli_prefix",
                    return_value=False,
                ),
                patch.object(
                    XiaoOAdapter,
                    "_run_supports_flag",
                    return_value=False,
                ),
            ):
                command = XiaoOAdapter._build_cli_command(
                    executable="xiaoo",
                    request=request,
                    artifacts=artifacts,
                    cli_model=None,
                    config_toml=config,
                    fault=fault,
                )
            self.assertEqual(command[:2], ["xiaoo", "run"])
            self.assertNotIn("--cli", command)
            self.assertNotIn("--format", command)

    def test_mark_ready_emits_activation_requested(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            artifacts = _artifacts(root)
            fault = FaultRegistry().get("step-omission")
            adapter = XiaoOAdapter()
            adapter._mark_ready_and_request_activation(
                artifacts=artifacts,
                fault=fault,
                source="adapter",
            )
            self.assertTrue(artifacts.plugin_ready_file.is_file())
            events = [
                json.loads(line)
                for line in artifacts.events_file.read_text(
                    encoding="utf-8"
                ).splitlines()
                if line.strip()
            ]
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0]["kind"], "fault.activation.requested")
            self.assertEqual(
                events[0]["payload"]["faultSkill"], fault.skill_name
            )
            self.assertIn("<agent-fault-injection>", events[0]["payload"]["instruction"])

            # Idempotent on second call.
            adapter._mark_ready_and_request_activation(
                artifacts=artifacts,
                fault=fault,
                source="adapter",
            )
            events2 = [
                line
                for line in artifacts.events_file.read_text(
                    encoding="utf-8"
                ).splitlines()
                if line.strip()
            ]
            self.assertEqual(len(events2), 1)

            from agent_fault_injection.trace import InsightInteractionsMapper

            document = InsightInteractionsMapper().map(
                artifacts,
                framework="xiaoo",
                prompt="task",
            )
            labels = [m["label"] for m in document.markers]
            self.assertIn("Fault activation requested", labels)
