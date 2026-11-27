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

from pathlib import Path
from unittest import TestCase

from agent_fault_injection.pipeline.exceptions import FaultNotFoundError
from agent_fault_injection.fault_inject.catalog.definition import FaultRegistry


class FaultRegistryTests(TestCase):
    def test_all_fault_skills_are_installed_for_both_platforms(self) -> None:
        """Exercise actual installers, including formerly omitted injection skills."""
        import tempfile

        from agent_fault_injection.fault_inject.injection.installer import InstallSession
        from agent_fault_injection.platform_adapters.opencode.adapter import OpenCodeAdapter
        from agent_fault_injection.platform_adapters.xiaoo.adapter import XiaoOAdapter

        registry = FaultRegistry()
        plugin_source = (
            Path(__file__).resolve().parents[2]
            / "platform_adapters/opencode/plugin/agent-fault-injection.ts"
        )
        with tempfile.TemporaryDirectory() as temporary:
            for name in registry.names():
                with self.subTest(fault=name):
                    fault = registry.get(name)
                    workspace = Path(temporary) / name
                    installation = InstallSession()
                    try:
                        OpenCodeAdapter._install_workspace_plugin_and_skill(
                            installation=installation,
                            workspace=workspace,
                            fault=fault,
                            plugin_source=plugin_source,
                        )
                        XiaoOAdapter._install_fault_skill(installation, fault, workspace)
                        for platform in (".opencode", ".xiaoo"):
                            installed = workspace / platform / "skills" / fault.skill_name / "SKILL.md"
                            self.assertEqual(
                                installed.read_text(encoding="utf-8"),
                                fault.skill_file.read_text(encoding="utf-8"),
                            )
                    finally:
                        installation.cleanup()

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

    def test_resolves_reasoning_no_progress_skill(self) -> None:
        fault = FaultRegistry().get("reasoning-no-progress")

        self.assertEqual(fault.skill_name, "reasoning-no-progress")
        self.assertTrue(fault.skill_file.is_file())
        self.assertEqual(fault.skill_file.parent.name, "reasoning-no-progress")
        self.assertEqual(Path(fault.skill_file).name, "SKILL.md")

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
            ("condition_one_test.py",),
        )
        self.assertTrue(all(path.is_file() for path in fault.tool_files))
        self.assertEqual(
            tuple(path.name for path in fault.agent_tool_files),
            ("condition_one_test.py",),
        )

    def test_resolves_execution_goal_drift_with_tools(self) -> None:
        fault = FaultRegistry().get("execution-goal-drift")

        self.assertEqual(fault.skill_name, "ras-routing-continuity-test")
        self.assertEqual(
            tuple(path.name for path in fault.tool_files),
            ("goal_state_tool.py",),
        )
        self.assertTrue(all(path.is_file() for path in fault.tool_files))

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
