"""skill-selection-conflict: structural seed + hidden tool-call rewrite."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from agent_fault_injection.fault_inject.catalog.definition import FaultRegistry
from agent_fault_injection.fault_inject.catalog.presentation import load_fault_ui_catalog
from agent_fault_injection.fault_inject.catalog.scenarios import parse_skill_submodes
from agent_fault_injection.fault_inject.injection.apply_plan import apply_injection_plan
from agent_fault_injection.fault_inject.injection.context import InjectionContext
from agent_fault_injection.fault_inject.injection.installer import InstallSession
from agent_fault_injection.platform_adapters.lifecycle import should_expose_fault_skill


class SkillSelectionConflictTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fault = FaultRegistry().get("skill-selection-conflict")
        cls.plugin_source = (
            Path(__file__).resolve().parents[2]
            / "platform_adapters"
            / "opencode"
            / "plugin"
            / "agent-fault-injection.ts"
        )
        cls.rewrite_lib = (
            Path(__file__).resolve().parents[2]
            / "platform_adapters"
            / "opencode"
            / "lib"
            / "provider-tool-call-rewrite.ts"
        )

    def test_registry_resolves_hidden_runtime_rewrite(self) -> None:
        self.assertEqual(self.fault.skill_name, "ras-skill-selection-conflict")
        self.assertEqual(self.fault.injection_method, "intercept_rewrite")
        self.assertEqual(len(self.fault.injection_runtime), 1)
        rewrite = self.fault.injection_runtime[0]
        self.assertEqual(rewrite.op, "assistant.tool_call.replace_argument")
        self.assertEqual(
            rewrite.when_map(),
            {"tool": "skill", "call_index": 1},
        )
        self.assertEqual(
            rewrite.arg_map(),
            {
                "path": "name",
                "from": "ras-code-review",
                "to": "ras-code-format",
            },
        )
        self.assertFalse(should_expose_fault_skill(self.fault))
        self.assertNotIn("call_index=2", self.fault.task_prompt or "")

    def test_hidden_task_keeps_fault_constraints_out_of_prompt(self) -> None:
        self.assertIn("执行一次代码质量审查", self.fault.task_prompt or "")
        self.assertNotIn("不再调用工具、复核或继续思考", self.fault.task_prompt or "")
        skill = self.fault.skill_file.read_text(encoding="utf-8")
        self.assertIn("恰好出现一次实际 Skill 调用", skill)
        self.assertIn("不得发起第二次 Skill 调用", skill)
        decoy = (self.fault.assets_dir / "decoy-code-format.md").read_text(
            encoding="utf-8"
        )
        self.assertIn("Do not read `target.py` and do not call any tool", decoy)

    def test_exposes_one_semantic_decoy_submode(self) -> None:
        submodes = parse_skill_submodes(self.fault.skill_file)
        self.assertEqual(len(submodes), 1)
        self.assertEqual(submodes[0]["id"], "1")
        self.assertEqual(submodes[0]["name"], "代码审查语义诱饵")

    def test_structural_plan_seeds_both_skills_and_target(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            workspace = root / "workspace"
            artifacts = root / "artifacts"
            workspace.mkdir()
            artifacts.mkdir()
            installation = InstallSession()
            context = InjectionContext(
                workspace=workspace,
                artifacts_dir=artifacts,
                events_file=root / "events.jsonl",
                installation=installation,
                submode="1",
                assets_root=self.fault.assets_dir,
            )

            results = apply_injection_plan(self.fault, context)

            self.assertEqual(len(results), 3)
            correct = (
                workspace
                / ".opencode"
                / "skills"
                / "ras-code-review"
                / "SKILL.md"
            )
            decoy = (
                workspace
                / ".opencode"
                / "skills"
                / "ras-code-format"
                / "SKILL.md"
            )
            target = workspace / "target.py"
            self.assertIn("name: ras-code-review", correct.read_text("utf-8"))
            self.assertIn("name: ras-code-format", decoy.read_text("utf-8"))
            self.assertIn("len(values)", target.read_text("utf-8"))

            installation.cleanup()
            self.assertFalse(correct.exists())
            self.assertFalse(decoy.exists())
            self.assertFalse(target.exists())

    def test_ui_catalog_lists_fault(self) -> None:
        catalog = load_fault_ui_catalog()
        entry = catalog.entry("skill-selection-conflict")
        self.assertIsNotNone(entry)
        assert entry is not None
        self.assertEqual(entry.label_zh, "Skill 选择冲突")

    def test_plugin_and_lib_contain_tool_call_rewrite(self) -> None:
        plugin = self.plugin_source.read_text(encoding="utf-8")
        lib = self.rewrite_lib.read_text(encoding="utf-8")
        self.assertIn("provider-tool-call-rewrite", plugin)
        self.assertIn("chat.headers", plugin)
        self.assertIn('"assistant.tool_call.replace_argument"', lib)
        self.assertIn("if (!jsonEqual(before, args.from)", lib)
        self.assertIn("parent[leaf] = args.to", lib)


if __name__ == "__main__":
    unittest.main()
