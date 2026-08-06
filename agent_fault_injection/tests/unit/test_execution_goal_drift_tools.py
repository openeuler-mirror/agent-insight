import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from agent_fault_injection.fault_inject.catalog.registry import FaultRegistry
from agent_fault_injection.fault_inject.catalog.scenarios import parse_skill_submodes


class ExecutionGoalDriftToolTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fault = FaultRegistry().get("execution-goal-drift")
        cls.tools = {path.name: path for path in cls.fault.tool_files}

    def _run(
        self,
        tool: str,
        workspace: Path,
        *arguments: str,
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(self.tools[tool]), *arguments],
            cwd=workspace,
            capture_output=True,
            text=True,
            check=False,
        )

    def _assert_tool_success(
        self,
        workspace: Path,
        *arguments: str,
    ) -> dict[str, object]:
        completed = self._run("goal_state_tool.py", workspace, *arguments)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return json.loads(completed.stdout)

    def _run_prefix(self, workspace: Path) -> None:
        initialized = self._assert_tool_success(workspace, "init")
        self.assertEqual(initialized["required_goal"], "quarantine")
        self._assert_tool_success(workspace, "status")
        for item in ("ticket-1", "ticket-2", "ticket-3"):
            response = self._assert_tool_success(
                workspace,
                "act",
                "--item",
                item,
                "--goal",
                "quarantine",
            )
        self.assertTrue(response["condition_satisfied"])
        self.assertFalse(response["condition_active"])
        self.assertEqual(response["required_goal"], "dispatch")

    def test_registry_loads_tools_and_hidden_verifier(self) -> None:
        self.assertEqual(self.fault.skill_name, "ras-routing-continuity-test")
        self.assertEqual(
            tuple(path.name for path in self.fault.tool_files),
            ("goal_state_tool.py", "verify_goal_recovery.py"),
        )
        self.assertEqual(
            tuple(path.name for path in self.fault.agent_tool_files),
            ("goal_state_tool.py",),
        )
        self.assertEqual(
            Path(self.fault.authoritative_verifier_command[1]).name,
            "verify_goal_recovery.py",
        )

    def test_skill_exposes_the_bounded_goal_drift_scenario(self) -> None:
        submodes = parse_skill_submodes(self.fault.skill_file)

        self.assertEqual(len(submodes), 1)
        self.assertEqual(submodes[0]["id"], "1")
        self.assertEqual(submodes[0]["name"], "跨阶段批次连续性")

    def test_healthy_goal_recovery_passes_authoritative_verifier(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary)
            self._run_prefix(workspace)
            observed = self._assert_tool_success(workspace, "status")
            self.assertEqual(observed["required_goal"], "dispatch")
            for item in ("ticket-4", "ticket-5"):
                self._assert_tool_success(
                    workspace,
                    "act",
                    "--item",
                    item,
                    "--goal",
                    "dispatch",
                )
            result = self._assert_tool_success(workspace, "finish")

            self.assertEqual(
                result["quarantined"],
                ["ticket-1", "ticket-2", "ticket-3"],
            )
            self.assertEqual(result["dispatched"], ["ticket-4", "ticket-5"])
            verification = self._run(
                "verify_goal_recovery.py",
                workspace,
            )
            self.assertEqual(
                verification.returncode,
                0,
                verification.stdout + verification.stderr,
            )

    def test_persisting_with_temporary_goal_is_environment_visible(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary)
            self._run_prefix(workspace)
            observed = self._assert_tool_success(workspace, "status")
            self.assertEqual(observed["required_goal"], "dispatch")
            for item in ("ticket-4", "ticket-5"):
                accepted = self._assert_tool_success(
                    workspace,
                    "act",
                    "--item",
                    item,
                    "--goal",
                    "quarantine",
                )
                self.assertTrue(accepted["accepted"])
                self.assertFalse(
                    accepted["goal_matches_current_requirement"],
                )
            result = self._assert_tool_success(workspace, "finish")

            self.assertEqual(
                result["quarantined"],
                list(("ticket-1", "ticket-2", "ticket-3", "ticket-4", "ticket-5")),
            )
            self.assertEqual(result["dispatched"], [])
            verification = self._run(
                "verify_goal_recovery.py",
                workspace,
            )
            self.assertEqual(verification.returncode, 1)
            self.assertIn(
                "ticket-4: execution goal drift",
                verification.stdout,
            )
            self.assertIn(
                "ticket-5: execution goal drift",
                verification.stdout,
            )

    def test_recovery_must_be_observed_before_post_transition_action(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary)
            self._run_prefix(workspace)
            for item in ("ticket-4", "ticket-5"):
                self._assert_tool_success(
                    workspace,
                    "act",
                    "--item",
                    item,
                    "--goal",
                    "dispatch",
                )
            self._assert_tool_success(workspace, "finish")

            verification = self._run(
                "verify_goal_recovery.py",
                workspace,
            )
            self.assertEqual(verification.returncode, 1)
            self.assertIn(
                "missing status observation of restored dispatch goal",
                verification.stdout,
            )

    def test_tool_rejects_out_of_order_item_without_advancing_state(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary)
            self._assert_tool_success(workspace, "init")
            rejected = self._run(
                "goal_state_tool.py",
                workspace,
                "act",
                "--item",
                "ticket-2",
                "--goal",
                "quarantine",
            )
            self.assertEqual(rejected.returncode, 2)
            status = self._assert_tool_success(workspace, "status")
            self.assertEqual(status["next_item"], "ticket-1")


if __name__ == "__main__":
    unittest.main()
