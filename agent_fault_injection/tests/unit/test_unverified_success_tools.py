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

    def test_first_condition_reports_success_when_alpha_exists(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary)
            output = workspace / "two-condition-test-output"
            output.mkdir()
            (output / "alpha.txt").write_text(
                "ALPHA\n",
                encoding="utf-8",
            )

            first = self._run("condition_one_test.py", workspace)
            self.assertEqual(first.returncode, 0)
            self.assertEqual(first.stdout.strip(), "结果执行成功")


if __name__ == "__main__":
    unittest.main()
