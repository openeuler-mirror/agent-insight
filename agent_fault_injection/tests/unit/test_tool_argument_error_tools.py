import unittest
from pathlib import Path

from agent_fault_injection.fault_inject.catalog.definition import FaultRegistry
from agent_fault_injection.fault_inject.catalog.scenarios import parse_skill_submodes
from agent_fault_injection.fault_inject.catalog.presentation import (
    load_fault_ui_catalog,
    resolve_fault_labels,
)


class ToolArgumentErrorToolTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fault = FaultRegistry().get("tool-argument-error")
        cls.tools = {path.name: path for path in cls.fault.tool_files}
        cls.plugin_source = (
            Path(__file__).parents[2]
            / "platform_adapters"
            / "opencode"
            / "plugin"
            / "agent-fault-injection.ts"
        )

    def test_registry_has_no_injected_tools(self) -> None:
        self.assertEqual(self.fault.skill_name, "ras-tool-argument-error")
        self.assertEqual(self.fault.tool_files, ())
        self.assertEqual(self.fault.agent_tool_files, ())
        self.assertEqual(len(self.fault.injection_runtime), 1)
        self.assertEqual(
            self.fault.injection_runtime[0].when_map(),
            {"tool": "order", "call_index": 1},
        )

    def test_hidden_task_keeps_fault_constraints_out_of_prompt(self) -> None:
        self.assertIn("读取一次 a.txt", self.fault.task_prompt or "")
        self.assertNotIn("不再调用工具、复核或继续思考", self.fault.task_prompt or "")
        skill = self.fault.skill_file.read_text(encoding="utf-8")
        self.assertIn("调用次数必须恰好为 1", skill)
        self.assertIn("禁止第二次工具调用", skill)

    def test_skill_exposes_one_native_argument_submode(self) -> None:
        submodes = parse_skill_submodes(self.fault.skill_file)

        self.assertEqual(len(submodes), 1)
        self.assertEqual(submodes[0]["id"], "1")
        self.assertEqual(submodes[0]["name"], "文件名参数替换")

    def test_ui_catalog_labels_tool_argument_error(self) -> None:
        catalog = load_fault_ui_catalog()

        self.assertIsNotNone(catalog.entry("tool-argument-error"))
        self.assertEqual(
            resolve_fault_labels(
                fault_id=self.fault.name,
                skill_file=self.fault.skill_file,
                catalog=catalog,
            ),
            ("工具参数错误", "tool-argument-error"),
        )

    def test_plugin_registers_native_order_with_structured_txt_schema(self) -> None:
        content = self.plugin_source.read_text(encoding="utf-8")

        self.assertIn('faultSkill === "ras-tool-argument-error"', content)
        self.assertIn("order: tool({", content)
        self.assertIn("txt: tool.schema", content)
        self.assertIn('.enum(["a.txt", "b.txt"])', content)
        self.assertIn("actual_arguments: { txt: args.txt }", content)

    def test_native_order_returns_only_success_to_the_agent(self) -> None:
        content = self.plugin_source.read_text(encoding="utf-8")
        return_block = content.split(
            'await record("native.order.executed", event)', 1
        )[1].split("            },", 1)[0]

        self.assertIn('title: "工具调用成功"', return_block)
        self.assertIn('output: "工具调用成功"', return_block)
        self.assertIn("metadata: { completed: true }", return_block)
        self.assertNotIn("JSON.stringify(result", return_block)
        self.assertNotIn("metadata: event", return_block)

if __name__ == "__main__":
    unittest.main()
