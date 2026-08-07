"""Unit tests for insight-compatible interactions mapping."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path
from unittest import TestCase

from agent_fault_injection.pipeline.models import RunArtifacts
from agent_fault_injection.pipeline.interactions_mapper import InsightInteractionsMapper, write_interactions_artifact


def _artifacts(root: Path) -> RunArtifacts:
    raw = root / "raw"
    raw.mkdir()
    return RunArtifacts(
        run_id="run-test",
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


class InsightInteractionsMapperTests(TestCase):
    def test_maps_session_messages_to_raw_interactions(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            artifacts = _artifacts(root)
            artifacts.session_file.write_text(
                json.dumps(
                    {
                        "session_id": "ses_abc",
                        "messages": [
                            {
                                "info": {
                                    "id": "msg_user",
                                    "role": "user",
                                    "time": {"created": 1_700_000_000_000},
                                },
                                "parts": [
                                    {"type": "text", "text": "fix the bug"}
                                ],
                            },
                            {
                                "info": {
                                    "id": "msg_asst",
                                    "role": "assistant",
                                    "agent": "build",
                                    "modelID": "test-model",
                                    "tokens": {"input": 10, "output": 5},
                                    "time": {"created": 1_700_000_000_100},
                                },
                                "parts": [
                                    {
                                        "type": "text",
                                        "text": "I will inspect the repo",
                                    },
                                    {
                                        "type": "tool",
                                        "tool": "bash",
                                        "callID": "call_1",
                                        "state": {
                                            "status": "completed",
                                            "input": {"command": "ls"},
                                            "output": "a.txt",
                                        },
                                    },
                                ],
                            },
                        ],
                    }
                ),
                encoding="utf-8",
            )
            artifacts.events_file.write_text(
                json.dumps(
                    {
                        "sequence": 1,
                        "recorded_at": 1_700_000_000_050,
                        "kind": "fault.activation.completed",
                        "payload": {"faultSkill": "ras-step-omission"},
                    }
                )
                + "\n",
                encoding="utf-8",
            )

            document = InsightInteractionsMapper().map(
                artifacts,
                framework="opencode",
                session_id="ses_abc",
            )
            write_interactions_artifact(artifacts, document)

            self.assertEqual(document.task_id, "ses_abc")
            self.assertEqual(len(document.interactions), 2)
            self.assertEqual(document.interactions[0]["role"], "user")
            self.assertEqual(document.interactions[0]["content"], "fix the bug")
            assistant = document.interactions[1]
            self.assertEqual(assistant["role"], "assistant")
            self.assertEqual(assistant["modelID"], "test-model")
            self.assertEqual(document.model_id, "test-model")
            self.assertTrue(assistant.get("tool_calls"))
            self.assertEqual(
                assistant["tool_calls"][0]["function"]["name"],
                "bash",
            )
            self.assertTrue(
                any(m["kind"] == "fault_activation" for m in document.markers)
            )
            saved = json.loads(
                artifacts.interactions_file.read_text(encoding="utf-8")
            )
            self.assertIn("interactions", saved)
            self.assertEqual(saved["framework"], "opencode")
            self.assertEqual(saved["taskId"], "ses_abc")
            self.assertEqual(saved["modelID"], "test-model")

    def test_maps_nested_model_fields(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            artifacts = _artifacts(root)
            artifacts.session_file.write_text(
                json.dumps(
                    {
                        "session_id": "ses_nested",
                        "messages": [
                            {
                                "info": {
                                    "id": "msg_user",
                                    "role": "user",
                                    "time": {"created": 1_700_000_000_000},
                                },
                                "parts": [{"type": "text", "text": "hello"}],
                            },
                            {
                                "info": {
                                    "id": "msg_asst",
                                    "role": "assistant",
                                    "model": {
                                        "id": "GLM-5.2",
                                        "providerID": "huawei-blue",
                                    },
                                    "time": {"created": 1_700_000_000_100},
                                },
                                "parts": [
                                    {"type": "text", "text": "nested model ok"}
                                ],
                            },
                            {
                                "info": {
                                    "id": "msg_asst2",
                                    "role": "assistant",
                                    "model": {
                                        "modelID": "other-model",
                                        "providerID": "other-provider",
                                    },
                                    "time": {"created": 1_700_000_000_200},
                                },
                                "parts": [
                                    {"type": "text", "text": "second assistant"}
                                ],
                            },
                        ],
                    }
                ),
                encoding="utf-8",
            )

            document = InsightInteractionsMapper().map(
                artifacts,
                framework="opencode",
                session_id="ses_nested",
            )
            write_interactions_artifact(artifacts, document)

            first = document.interactions[1]
            self.assertEqual(first["modelID"], "GLM-5.2")
            self.assertEqual(first["providerID"], "huawei-blue")
            second = document.interactions[2]
            self.assertEqual(second["modelID"], "other-model")
            self.assertEqual(second["providerID"], "other-provider")
            # Document summary uses first non-empty assistant model fields.
            self.assertEqual(document.model_id, "GLM-5.2")
            self.assertEqual(document.provider_id, "huawei-blue")
            saved = json.loads(
                artifacts.interactions_file.read_text(encoding="utf-8")
            )
            self.assertEqual(saved["modelID"], "GLM-5.2")
            self.assertEqual(saved["providerID"], "huawei-blue")

    def test_document_model_from_early_events_without_session(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            artifacts = _artifacts(root)
            artifacts.events_file.write_text(
                json.dumps(
                    {
                        "kind": "opencode.event",
                        "payload": {
                            "type": "session.updated",
                            "properties": {
                                "info": {
                                    "id": "ses_x",
                                    "model": {
                                        "id": "GLM-5.2",
                                        "providerID": "huawei-blue",
                                    },
                                }
                            },
                        },
                    }
                )
                + "\n",
                encoding="utf-8",
            )

            document = InsightInteractionsMapper().map(
                artifacts,
                framework="opencode",
            )
            self.assertEqual(document.model_id, "GLM-5.2")
            self.assertEqual(document.provider_id, "huawei-blue")

    def test_document_model_from_request_option(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            artifacts = _artifacts(root)
            artifacts.request_file.write_text(
                json.dumps(
                    {
                        "platform": "opencode",
                        "platform_options": {"model": "acme/demo-model"},
                    }
                ),
                encoding="utf-8",
            )

            document = InsightInteractionsMapper().map(
                artifacts,
                framework="opencode",
            )
            self.assertEqual(document.model_id, "demo-model")
            self.assertEqual(document.provider_id, "acme")

    def test_tool_timing_from_part_state_time(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            artifacts = _artifacts(root)
            artifacts.session_file.write_text(
                json.dumps(
                    {
                        "session_id": "ses_tool",
                        "messages": [
                            {
                                "info": {
                                    "id": "msg_asst",
                                    "role": "assistant",
                                    "tokens": {
                                        "total": 100,
                                        "input": 80,
                                        "output": 20,
                                    },
                                    "time": {
                                        "created": 1_700_000_000_000,
                                        "completed": 1_700_000_010_000,
                                    },
                                },
                                "parts": [
                                    {
                                        "type": "tool",
                                        "tool": "skill",
                                        "callID": "call_1",
                                        "state": {
                                            "status": "completed",
                                            "input": {"name": "x"},
                                            "output": "ok",
                                            "time": {
                                                "start": 1_700_000_005_000,
                                                "end": 1_700_000_005_700,
                                            },
                                        },
                                    }
                                ],
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )

            document = InsightInteractionsMapper().map(artifacts, framework="opencode")
            assistant = document.interactions[0]
            self.assertEqual(assistant["usage"]["total"], 100)
            timing = assistant["tool_calls"][0]["timing"]
            self.assertEqual(timing["started_at"], 1_700_000_005_000)
            self.assertEqual(timing["completed_at"], 1_700_000_005_700)

    def test_fallback_rebuilds_usage_and_time_from_events(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            artifacts = _artifacts(root)
            events = [
                {
                    "kind": "opencode.event",
                    "recorded_at": 1_700_000_000_000,
                    "payload": {
                        "type": "message.updated",
                        "properties": {
                            "info": {
                                "id": "msg_user",
                                "role": "user",
                                "time": {"created": 1_700_000_000_000},
                            }
                        },
                    },
                },
                {
                    "kind": "opencode.event",
                    "recorded_at": 1_700_000_000_050,
                    "payload": {
                        "type": "message.part.updated",
                        "properties": {
                            "part": {
                                "id": "prt_u",
                                "messageID": "msg_user",
                                "type": "text",
                                "text": "do it",
                            }
                        },
                    },
                },
                {
                    "kind": "opencode.event",
                    "recorded_at": 1_700_000_001_000,
                    "payload": {
                        "type": "message.updated",
                        "properties": {
                            "info": {
                                "id": "msg_asst",
                                "role": "assistant",
                                "modelID": "m1",
                                "providerID": "p1",
                                "tokens": {
                                    "total": 12848,
                                    "input": 11652,
                                    "output": 14,
                                    "reasoning": 30,
                                    "cache": {"read": 1152, "write": 0},
                                },
                                "time": {
                                    "created": 1_700_000_001_000,
                                    "completed": 1_700_000_009_135,
                                },
                            }
                        },
                    },
                },
                {
                    "kind": "opencode.event",
                    "recorded_at": 1_700_000_008_000,
                    "payload": {
                        "type": "message.part.updated",
                        "properties": {
                            "part": {
                                "id": "prt_tool",
                                "messageID": "msg_asst",
                                "type": "tool",
                                "tool": "skill",
                                "callID": "call_x",
                                "state": {
                                    "status": "completed",
                                    "input": {"name": "thinking-dead-loop"},
                                    "output": "loaded",
                                    "time": {
                                        "start": 1_700_000_008_000,
                                        "end": 1_700_000_008_698,
                                    },
                                },
                            }
                        },
                    },
                },
            ]
            artifacts.events_file.write_text(
                "".join(json.dumps(item) + "\n" for item in events),
                encoding="utf-8",
            )

            document = InsightInteractionsMapper().map(
                artifacts,
                framework="opencode",
                prompt="ignored because message events exist",
            )
            self.assertEqual(len(document.interactions), 2)
            assistant = document.interactions[1]
            self.assertEqual(assistant["usage"]["total"], 12848)
            self.assertEqual(assistant["timeInfo"]["created"], 1_700_000_001_000)
            self.assertEqual(assistant["timeInfo"]["completed"], 1_700_000_009_135)
            self.assertEqual(
                assistant["tool_calls"][0]["timing"]["completed_at"],
                1_700_000_008_698,
            )
            user = document.interactions[0]
            self.assertEqual(user["timeInfo"]["created"], 1_700_000_000_000)
            # Timestamp must come from the event, not mapping-time "now".
            self.assertTrue(str(user.get("timestamp", "")).startswith("2023-"))

    def test_xiaoo_events_rebuild_tool_chain_and_final_reply(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            artifacts = _artifacts(root)
            artifacts.request_file.write_text(
                json.dumps(
                    {
                        "platform": "xiaoo",
                        "platform_options": {
                            "model": "minimax-anthropic/Minimax-M2.7-highspeed"
                        },
                    }
                ),
                encoding="utf-8",
            )
            events = [
                {
                    "schema_version": "1",
                    "run_id": "run-test",
                    "sequence": 1,
                    "recorded_at": 1_700_000_000_100,
                    "kind": "fault.activation.started",
                    "payload": {"skill": "ras-step-omission"},
                },
                {
                    "schema_version": "1",
                    "run_id": "run-test",
                    "sequence": 2,
                    "recorded_at": 1_700_000_000_200,
                    "kind": "xiaoo.event",
                    "payload": {
                        "type": "tool.pre",
                        "tool": "skill",
                        "call_id": "call_function_skill_1",
                        "callID": "call_function_skill_1",
                        "input": {"skill": "ras-step-omission"},
                    },
                },
                {
                    "schema_version": "1",
                    "run_id": "run-test",
                    "sequence": 3,
                    "recorded_at": 1_700_000_000_300,
                    "kind": "xiaoo.event",
                    "payload": {
                        "type": "tool.post",
                        "tool": "skill",
                        "call_id": "call_function_skill_1",
                        "callID": "call_function_skill_1",
                        "input": {"skill": "ras-step-omission"},
                        "outcome": {"type": "success", "output": "loaded"},
                    },
                },
                {
                    "schema_version": "1",
                    "run_id": "run-test",
                    "sequence": 4,
                    "recorded_at": 1_700_000_000_400,
                    "kind": "fault.activation.completed",
                    "payload": {"skill": "ras-step-omission"},
                },
                {
                    "schema_version": "1",
                    "run_id": "run-test",
                    "sequence": 5,
                    "recorded_at": 1_700_000_000_500,
                    "kind": "xiaoo.event",
                    "payload": {
                        "type": "tool.pre",
                        "tool": "bash",
                        "call_id": "call_function_bash_1",
                        "callID": "call_function_bash_1",
                        "input": {"command": "ls"},
                    },
                },
                {
                    "schema_version": "1",
                    "run_id": "run-test",
                    "sequence": 6,
                    "recorded_at": 1_700_000_000_600,
                    "kind": "xiaoo.event",
                    "payload": {
                        "type": "tool.post",
                        "tool": "bash",
                        "call_id": "call_function_bash_1",
                        "callID": "call_function_bash_1",
                        "input": {"command": "ls"},
                        "outcome": {"type": "success", "output": "alpha.txt"},
                    },
                },
                {
                    "schema_version": "1",
                    "run_id": "run-test",
                    "sequence": 7,
                    "recorded_at": 1_700_000_000_700,
                    "kind": "xiaoo.cli",
                    "payload": {
                        "type": "response",
                        "data": {"raw_reply": "done with scenario 1"},
                    },
                },
            ]
            artifacts.events_file.write_text(
                "".join(json.dumps(item) + "\n" for item in events),
                encoding="utf-8",
            )

            document = InsightInteractionsMapper().map(
                artifacts,
                framework="xiaoo",
                prompt="Execute step-omission scenario 1",
            )
            write_interactions_artifact(artifacts, document)

            self.assertEqual(document.framework, "xiaoo")
            self.assertEqual(document.model_id, "Minimax-M2.7-highspeed")
            self.assertEqual(document.provider_id, "minimax-anthropic")
            self.assertGreaterEqual(len(document.interactions), 4)
            self.assertEqual(document.interactions[0]["role"], "user")
            skill = document.interactions[1]
            self.assertEqual(skill["role"], "assistant")
            self.assertEqual(skill["modelID"], "Minimax-M2.7-highspeed")
            self.assertEqual(skill["providerID"], "minimax-anthropic")
            self.assertEqual(skill["tool_calls"][0]["function"]["name"], "skill")
            self.assertEqual(skill["tool_calls"][0]["id"], "call_function_skill_1")
            self.assertEqual(skill["tool_calls"][0]["output"], "loaded")
            bash = document.interactions[2]
            self.assertEqual(bash["tool_calls"][0]["function"]["name"], "bash")
            self.assertEqual(bash["tool_calls"][0]["id"], "call_function_bash_1")
            final = document.interactions[-1]
            self.assertEqual(final["role"], "assistant")
            self.assertEqual(final["content"], "done with scenario 1")
            self.assertEqual(final["modelID"], "Minimax-M2.7-highspeed")

    def test_xiaoo_resolved_llm_fills_model_when_request_omits_it(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            artifacts = _artifacts(root)
            artifacts.request_file.write_text(
                json.dumps(
                    {
                        "platform": "xiaoo",
                        "platform_options": {"auto": True},
                    }
                ),
                encoding="utf-8",
            )
            (artifacts.raw_dir / "resolved-llm.json").write_text(
                json.dumps(
                    {
                        "providerID": "minimax-anthropic",
                        "modelID": "Minimax-M2.7-highspeed",
                        "id": "minimax-anthropic/Minimax-M2.7-highspeed",
                        "source": "user_config",
                    }
                ),
                encoding="utf-8",
            )
            events = [
                {
                    "schema_version": "1",
                    "run_id": "run-test",
                    "sequence": 1,
                    "recorded_at": 1_700_000_000_200,
                    "kind": "xiaoo.event",
                    "payload": {
                        "type": "tool.pre",
                        "tool": "skill",
                        "input": {"skill": "thinking-dead-loop"},
                    },
                },
                {
                    "schema_version": "1",
                    "run_id": "run-test",
                    "sequence": 2,
                    "recorded_at": 1_700_000_000_300,
                    "kind": "xiaoo.event",
                    "payload": {
                        "type": "tool.post",
                        "tool": "skill",
                        "input": {"skill": "thinking-dead-loop"},
                        "outcome": {"type": "success", "output": "loaded"},
                    },
                },
            ]
            artifacts.events_file.write_text(
                "".join(json.dumps(item) + "\n" for item in events),
                encoding="utf-8",
            )

            document = InsightInteractionsMapper().map(
                artifacts,
                framework="xiaoo",
                prompt="run fault",
            )
            self.assertEqual(document.model_id, "Minimax-M2.7-highspeed")
            self.assertEqual(document.provider_id, "minimax-anthropic")
            assistant = next(
                item for item in document.interactions if item.get("role") == "assistant"
            )
            self.assertEqual(assistant["modelID"], "Minimax-M2.7-highspeed")
            self.assertEqual(assistant["providerID"], "minimax-anthropic")
