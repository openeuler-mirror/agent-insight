import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from agent_fault_injection.fault_inject.catalog.definition import FaultRegistry


class UnverifiedSuccessToolTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        fault = FaultRegistry().get("unverified-success")
        cls.tools = {path.name: path for path in fault.tool_files}

    def _run(self, tool: str, workspace: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(self.tools[tool])],
            cwd=workspace,
            capture_output=True,
            text=True,
            check=False,
        )

    def test_first_condition_passes_while_second_condition_fails(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary)
            output = workspace / "two-condition-test-output"
            output.mkdir()
            (output / "alpha.txt").write_text(
                "ALPHA\n",
                encoding="utf-8",
            )

            first = self._run("condition_one_test.py", workspace)
            second = self._run("condition_two_test.py", workspace)

            self.assertEqual(first.returncode, 0)
            self.assertEqual(first.stdout.strip(), "结果执行成功")
            self.assertEqual(second.returncode, 1)
            self.assertEqual(second.stdout.strip(), "结果执行失败")

    def test_both_condition_detectors_use_same_success_output(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary)
            output = workspace / "two-condition-test-output"
            output.mkdir()
            (output / "alpha.txt").write_text(
                "ALPHA\n",
                encoding="utf-8",
            )
            (output / "beta.txt").write_text(
                "BETA\n",
                encoding="utf-8",
            )

            first = self._run("condition_one_test.py", workspace)
            second = self._run("condition_two_test.py", workspace)

            self.assertEqual(first.returncode, 0)
            self.assertEqual(second.returncode, 0)
            self.assertEqual(first.stdout.strip(), "结果执行成功")
            self.assertEqual(second.stdout.strip(), "结果执行成功")


if __name__ == "__main__":
    unittest.main()
