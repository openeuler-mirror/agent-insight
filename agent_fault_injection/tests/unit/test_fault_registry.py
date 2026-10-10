from pathlib import Path
from unittest import TestCase

from agent_fault_injection.pipeline.exceptions import FaultNotFoundError
from agent_fault_injection.fault_inject.catalog.definition import FaultRegistry


class FaultRegistryTests(TestCase):
    def test_resolves_step_omission_skill(self) -> None:
        fault = FaultRegistry().get("step-omission")

        self.assertEqual(fault.skill_name, "ras-step-omission")
        self.assertTrue(fault.skill_file.is_file())
        self.assertEqual(Path(fault.skill_file).name, "SKILL.md")

    def test_resolves_step_order_error_skill(self) -> None:
        fault = FaultRegistry().get("step-order-error")

        self.assertEqual(fault.skill_name, "ras-step-order-error")
        self.assertTrue(fault.skill_file.is_file())
        self.assertEqual(fault.skill_file.parent.name, "step-order-error")

    def test_resolves_tool_selection_error_skill(self) -> None:
        fault = FaultRegistry().get("tool-selection-error")

        self.assertEqual(fault.skill_name, "ras-tool-selection-error")
        self.assertTrue(fault.skill_file.is_file())
        self.assertEqual(
            fault.skill_file.parent.name, "tool-selection-error"
        )
        content = fault.skill_file.read_text(encoding="utf-8")
        self.assertIn(
            "错误调用返回后的工具调用数量必须为 **0**",
            content,
        )
        self.assertIn("`occurred + unresolved`", content)
        self.assertNotIn("Agent 可以自行验证或恢复", content)

    def test_resolves_analysis_paralysis_skill(self) -> None:
        fault = FaultRegistry().get("analysis-paralysis")

        self.assertEqual(fault.skill_name, "analysis-paralysis")
        self.assertTrue(fault.skill_file.is_file())
        self.assertEqual(fault.skill_file.parent.name, "analysis-paralysis")
        self.assertEqual(Path(fault.skill_file).name, "SKILL.md")

    def test_resolves_planning_logic_error_skill(self) -> None:
        fault = FaultRegistry().get("planning-logic-error")

        self.assertEqual(fault.skill_name, "ras-planning-logic-error")
        self.assertTrue(fault.skill_file.is_file())
        self.assertEqual(fault.skill_file.parent.name, "planning-logic-error")
        self.assertIn("Planning Logic Error", fault.description)

    def test_resolves_unverified_success_with_tools(self) -> None:
        fault = FaultRegistry().get("unverified-success")

        self.assertEqual(fault.skill_name, "ras-two-condition-test")
        self.assertEqual(
            tuple(path.name for path in fault.tool_files),
            ("condition_one_test.py", "condition_two_test.py"),
        )
        self.assertTrue(all(path.is_file() for path in fault.tool_files))
        self.assertEqual(
            tuple(path.name for path in fault.agent_tool_files),
            ("condition_one_test.py",),
        )
        self.assertIsNotNone(fault.authoritative_verifier_command)
        assert fault.authoritative_verifier_command is not None
        self.assertEqual(fault.authoritative_verifier_command[0], "python3")
        self.assertEqual(
            Path(fault.authoritative_verifier_command[1]).name,
            "condition_two_test.py",
        )
        self.assertEqual(fault.authoritative_verifier_timeout_seconds, 30)

    def test_resolves_execution_goal_drift_with_tools(self) -> None:
        fault = FaultRegistry().get("execution-goal-drift")

        self.assertEqual(fault.skill_name, "ras-routing-continuity-test")
        self.assertEqual(
            tuple(path.name for path in fault.tool_files),
            ("goal_state_tool.py", "verify_goal_recovery.py"),
        )
        self.assertTrue(all(path.is_file() for path in fault.tool_files))
        self.assertIsNotNone(fault.authoritative_verifier_command)

    def test_unknown_fault_lists_available_names(self) -> None:
        with self.assertRaisesRegex(
            FaultNotFoundError,
            "step-omission, step-order-error",
        ):
            FaultRegistry().get("missing")

    def test_discovers_fault_directory_without_registry_edit(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fault_dir = root / "tool-timeout"
            fault_dir.mkdir()
            (fault_dir / "SKILL.md").write_text(
                "\n".join(
                    [
                        "---",
                        "name: ras-tool-timeout",
                        "description: Inject one controlled tool timeout.",
                        "---",
                        "",
                        "# Tool timeout",
                    ]
                ),
                encoding="utf-8",
            )

            fault = FaultRegistry(root).get("tool-timeout")

            self.assertEqual(fault.skill_name, "ras-tool-timeout")
            self.assertEqual(
                fault.description,
                "Inject one controlled tool timeout.",
            )
