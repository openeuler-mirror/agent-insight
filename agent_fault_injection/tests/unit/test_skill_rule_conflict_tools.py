import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from agent_fault_injection.fault_inject.catalog.definition import FaultRegistry
from agent_fault_injection.platform_adapters.lifecycle import should_expose_fault_skill


class SkillRuleConflictToolTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fault = FaultRegistry().get("skill-rule-conflict")
        cls.tool = next(
            path for path in cls.fault.tool_files if path.name == "csv_conflict_tool.py"
        )

    def _run(self, workspace: Path, *arguments: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(self.tool), *arguments],
            cwd=workspace,
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
        )

    def _seed_report(self, workspace: Path) -> None:
        shutil.copy2(self.fault.assets_dir / "report.csv", workspace / "report.csv")

    def _events(self, workspace: Path) -> list[dict[str, object]]:
        path = workspace / "skill-rule-conflict-output" / "events.jsonl"
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]

    def _run_full_sequence(
        self,
        workspace: Path,
        normalize_target: str,
        analyze_input: str,
    ) -> None:
        for arguments in (
            ("init",),
            ("normalize", "--target", normalize_target),
            ("analyze", "--input", analyze_input),
            ("finish",),
        ):
            result = self._run(workspace, *arguments)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_definition_is_hidden_zero_runtime_structural_injection(self) -> None:
        self.assertFalse(should_expose_fault_skill(self.fault))
        self.assertEqual(self.fault.injection_method, "skill_inject")
        self.assertEqual(len(self.fault.injection_runtime), 0)
        self.assertEqual(len(self.fault.injection_plan), 4)
        self.assertEqual(
            [path.name for path in self.fault.agent_tool_files],
            ["csv_conflict_tool.py"],
        )
        self.assertEqual(
            [path.name for path in self.fault.tool_files],
            ["csv_conflict_tool.py"],
        )
        self.assertNotIn("冲突", self.fault.task_prompt or "")

    def test_assets_define_conflicting_rules_and_full_pipeline(self) -> None:
        skill_a = (self.fault.assets_dir / "skill-a-financial-analysis.md").read_text(
            encoding="utf-8"
        )
        skill_b = (self.fault.assets_dir / "skill-b-csv-normalization.md").read_text(
            encoding="utf-8"
        )
        pipeline = (
            self.fault.assets_dir / "ras-csv-analysis-pipeline.md"
        ).read_text(encoding="utf-8")

        self.assertIn("report.normalized.csv", skill_a)
        self.assertIn("禁止修改 report.csv", skill_a)
        self.assertIn("原位覆盖 report.csv", skill_b)
        self.assertIn("禁止创建派生副本", skill_b)
        self.assertIn("init → normalize → analyze → finish", pipeline)
        self.assertIn("不得跳过", pipeline)
        self.assertIn("CONFLICT_TASK_COMPLETE", pipeline)
        self.assertNotIn("冲突", pipeline)
        self.assertNotIn("矛盾", pipeline)
        self.assertNotIn("CSV_NORMALIZATION_COMPLETE", pipeline)

    def test_copy_path_runs_complete_workflow(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary)
            self._seed_report(workspace)
            self._run_full_sequence(workspace, "copy", "report.normalized.csv")

            events = self._events(workspace)
            self.assertEqual(
                [event["event"] for event in events],
                ["init", "normalize", "analyze", "finish"],
            )
            self.assertEqual(events[1]["target"], "copy")
            self.assertFalse(events[1]["overwritten_original"])

    def test_source_path_runs_complete_workflow(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary)
            self._seed_report(workspace)
            self._run_full_sequence(workspace, "source", "report.csv")

            events = self._events(workspace)
            self.assertEqual(events[1]["target"], "source")
            self.assertTrue(events[1]["overwritten_original"])
            self.assertTrue(events[-1]["accepted"])

    def test_two_normalizations_are_observable_and_third_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary)
            self._seed_report(workspace)
            self.assertEqual(self._run(workspace, "init").returncode, 0)
            self.assertEqual(
                self._run(workspace, "normalize", "--target", "copy").returncode,
                0,
            )
            self.assertEqual(
                self._run(workspace, "normalize", "--target", "source").returncode,
                0,
            )
            rejected = self._run(workspace, "normalize", "--target", "copy")

            self.assertNotEqual(rejected.returncode, 0)
            events = self._events(workspace)
            self.assertEqual([event["sequence"] for event in events], [1, 2, 3, 4])
            self.assertEqual(events[-1]["event"], "normalize")
            self.assertFalse(events[-1]["accepted"])
            self.assertEqual(events[-1]["reason"], "normalize_rejected")

    def test_agent_may_stop_after_conflict_action_without_finish(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary)
            self._seed_report(workspace)
            self.assertEqual(self._run(workspace, "init").returncode, 0)
            self.assertEqual(
                self._run(workspace, "normalize", "--target", "copy").returncode,
                0,
            )

            events = self._events(workspace)
            self.assertEqual([event["event"] for event in events], ["init", "normalize"])
            state = json.loads(
                (workspace / "skill-rule-conflict-output" / "state.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertFalse(state["finished"])


if __name__ == "__main__":
    unittest.main()
