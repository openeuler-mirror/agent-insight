"""Tests for fault skill submode parsing."""

from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from agent_fault_injection.fault_inject.catalog.definition import FaultRegistry
from agent_fault_injection.fault_inject.catalog.scenarios import (
    compose_fault_prompt,
    find_submode,
    parse_skill_submodes,
)


class SkillSubmodeParseTests(TestCase):
    def test_parses_thinking_dead_loop_overview_table(self) -> None:
        fault = FaultRegistry().get("thinking-dead-loop")
        submodes = parse_skill_submodes(fault.skill_file)

        self.assertEqual([item["id"] for item in submodes], ["1", "2", "3"])
        self.assertEqual(submodes[0]["name"], "字面重复死循环")
        self.assertEqual(submodes[1]["name"], "逻辑死循环")
        self.assertEqual(submodes[2]["name"], "计划-执行死循环")

    def test_parses_planning_logic_error_overview_table(self) -> None:
        fault = FaultRegistry().get("planning-logic-error")
        submodes = parse_skill_submodes(fault.skill_file)

        self.assertEqual([item["id"] for item in submodes], ["1", "2", "3"])
        self.assertEqual(submodes[0]["name"], "依赖颠倒")
        self.assertEqual(submodes[1]["name"], "环依赖")
        self.assertEqual(submodes[2]["name"], "步骤缺失")
        self.assertIn("依赖方向写反", submodes[0]["description"])
        self.assertIn("无法收敛的依赖环", submodes[1]["description"])
        self.assertIn("内容清单", submodes[2]["description"])

    def test_parses_memory_noise_interference_overview_table(self) -> None:
        fault = FaultRegistry().get("memory-noise-interference")
        submodes = parse_skill_submodes(fault.skill_file)

        self.assertEqual([item["id"] for item in submodes], ["1", "2", "3"])
        self.assertEqual(submodes[0]["name"], "无关历史噪声")
        self.assertEqual(submodes[1]["name"], "冲突事实噪声")
        self.assertEqual(submodes[2]["name"], "错误响应噪声")
        self.assertIn("会议室", submodes[0]["description"])
        self.assertIn("汇率", submodes[1]["description"])
        self.assertIn("HTTP", submodes[2]["description"])
        self.assertIsNone(find_submode(submodes, "4"))

    def test_parses_tool_repeat_overview_table(self) -> None:
        fault = FaultRegistry().get("tool_repeat_dead_loop")
        submodes = parse_skill_submodes(fault.skill_file)

        self.assertEqual(
            [item["id"] for item in submodes],
            ["1", "2", "3", "4"],
        )
        self.assertEqual(submodes[0]["name"], "generic_repeat")
        self.assertEqual(submodes[3]["name"], "ping_pong")

    def test_falls_back_to_scene_headings(self) -> None:
        fault = FaultRegistry().get("step-omission")
        submodes = parse_skill_submodes(fault.skill_file)

        self.assertEqual(len(submodes), 1)
        self.assertEqual(submodes[0]["id"], "1")
        self.assertIn("beta", submodes[0]["name"])

    def test_compose_prompt_includes_submode(self) -> None:
        prompt = compose_fault_prompt(
            skill_name="thinking-dead-loop",
            base_prompt="do the task",
            submode={"id": "2", "name": "逻辑死循环", "description": ""},
        )
        self.assertIn("执行逻辑死循环", prompt)
        self.assertIn("do the task", prompt)

    def test_find_submode_by_id(self) -> None:
        with TemporaryDirectory() as temporary:
            skill = Path(temporary) / "SKILL.md"
            skill.write_text(
                "\n".join(
                    [
                        "---",
                        "name: demo",
                        "description: demo",
                        "---",
                        "",
                        "| 场景 | 名称 |",
                        "|---|---|",
                        "| 1 | Alpha |",
                        "| 2 | Beta |",
                        "",
                        "## 场景1：Alpha",
                    ]
                ),
                encoding="utf-8",
            )
            submodes = parse_skill_submodes(skill)
            self.assertEqual(find_submode(submodes, "2")["name"], "Beta")
