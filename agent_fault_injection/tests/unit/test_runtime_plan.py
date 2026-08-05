"""Unit tests for injection.runtime plan parsing and tool_result rewrite."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path
from unittest import TestCase

from agent_fault_injection.fault_inject.catalog import load_fault_definition
from agent_fault_injection.fault_inject.injection_tools.runtime_plan import (
    apply_assistant_text_rewrite,
    apply_messages_rewrite,
    apply_system_rewrite,
    apply_tool_result_rewrite,
    runtime_plan_to_json,
)


class RuntimePlanTests(TestCase):
    def test_loads_injection_runtime_from_fault_json(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fault_dir = root / "tool-result-corruption"
            fault_dir.mkdir()
            (fault_dir / "SKILL.md").write_text(
                "\n".join(
                    [
                        "---",
                        "name: ras-tool-result-corruption",
                        "description: Rewrite one tool result for FI.",
                        "---",
                        "",
                        "# Tool result corruption",
                    ]
                ),
                encoding="utf-8",
            )
            (fault_dir / "fault.json").write_text(
                json.dumps(
                    {
                        "name": "tool-result-corruption",
                        "skill_name": "ras-tool-result-corruption",
                        "category": "tool_result_tamper",
                        "description": "Rewrite one tool result for FI.",
                        "injection_method": "tool_result_tamper",
                        "injection": {
                            "runtime": [
                                {
                                    "op": "tool_result.replace_text",
                                    "when": {"tool": "read|file_read", "call_index": 1},
                                    "args": {
                                        "from": "RAS_TOOL_OK",
                                        "to": "RAS_TOOL_FAULT",
                                    },
                                }
                            ]
                        },
                    }
                ),
                encoding="utf-8",
            )

            fault = load_fault_definition(fault_dir)
            self.assertEqual(fault.injection_method, "tool_result_tamper")
            self.assertEqual(len(fault.injection_runtime), 1)
            step = fault.injection_runtime[0]
            self.assertEqual(step.op, "tool_result.replace_text")
            self.assertEqual(step.when_map().get("call_index"), 1)
            self.assertEqual(step.arg_map().get("from"), "RAS_TOOL_OK")
            payload = json.loads(runtime_plan_to_json(fault.injection_runtime))
            self.assertEqual(payload[0]["op"], "tool_result.replace_text")
            self.assertEqual(payload[0]["when"]["call_index"], 1)

    def test_apply_tool_result_rewrite_on_matching_call(self) -> None:
        plan = [
            {
                "op": "tool_result.replace_text",
                "when": {"tool": "read|file_read", "call_index": 1},
                "args": {"from": "RAS_TOOL_OK", "to": "RAS_TOOL_FAULT"},
            }
        ]
        rewritten, meta = apply_tool_result_rewrite(
            plan,
            tool="read",
            call_index=1,
            output="value=RAS_TOOL_OK\n",
        )
        self.assertEqual(rewritten, "value=RAS_TOOL_FAULT\n")
        self.assertTrue(meta["applied"])
        self.assertEqual(meta["op"], "tool_result.replace_text")

        unchanged, meta2 = apply_tool_result_rewrite(
            plan,
            tool="read",
            call_index=2,
            output="value=RAS_TOOL_OK\n",
        )
        self.assertEqual(unchanged, "value=RAS_TOOL_OK\n")
        self.assertFalse(meta2["applied"])

    def test_rewrite_skips_until_needle_found(self) -> None:
        plan = [
            {
                "op": "tool_result.replace_text",
                "when": {"tool": "read|file_read"},
                "args": {"from": "RAS_TOOL_OK", "to": "RAS_TOOL_FAULT"},
            }
        ]
        unchanged, meta = apply_tool_result_rewrite(
            plan,
            tool="read",
            call_index=1,
            output="unrelated file",
        )
        self.assertEqual(unchanged, "unrelated file")
        self.assertFalse(meta["applied"])
        rewritten, meta2 = apply_tool_result_rewrite(
            plan,
            tool="read",
            call_index=2,
            output="TOKEN=RAS_TOOL_OK\n",
        )
        self.assertEqual(rewritten, "TOKEN=RAS_TOOL_FAULT\n")
        self.assertTrue(meta2["applied"])

    def test_apply_system_and_messages_and_assistant(self) -> None:
        system_plan = [
            {"op": "system.append", "args": {"text": "OVERRIDE"}},
        ]
        parts, meta = apply_system_rewrite(system_plan, system_parts=["base"])
        self.assertEqual(parts[-1], "OVERRIDE")
        self.assertTrue(meta["applied"])

        msg_plan = [
            {
                "op": "messages.inject",
                "args": {
                    "role": "user",
                    "text": "PRIOR TOKEN=RAS_HIST_FAULT",
                    "position": "merge_user",
                },
            }
        ]
        messages, meta2 = apply_messages_rewrite(
            msg_plan,
            messages=[{"role": "user", "content": "task"}],
        )
        self.assertEqual(len(messages), 1)
        self.assertIn("RAS_HIST_FAULT", messages[0]["content"])
        self.assertTrue(meta2["applied"])

        asst_plan = [
            {
                "op": "assistant.replace_text",
                "args": {"from": "RAS_ASSIST_OK", "to": "RAS_ASSIST_FAULT"},
            }
        ]
        text, meta3 = apply_assistant_text_rewrite(
            asst_plan,
            text="TOKEN=RAS_ASSIST_OK",
            call_index=1,
        )
        self.assertEqual(text, "TOKEN=RAS_ASSIST_FAULT")
        self.assertTrue(meta3["applied"])
