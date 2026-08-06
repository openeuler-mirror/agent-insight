import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from agent_fault_injection.fault_inject.catalog.registry import FaultRegistry
from agent_fault_injection.fault_inject.catalog.scenarios import parse_skill_submodes
from agent_fault_injection.fault_inject.catalog.ui_catalog import (
    load_fault_ui_catalog,
    resolve_fault_labels,
)


FIXTURE_CONTENT = {
    "a.txt": "TARGET FILE\nrequest-id: A-001\n",
    "b.txt": "DECOY FILE\nrequest-id: B-002\n",
}


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

    def _run_verifier(
        self,
        workspace: Path,
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(self.tools["verify_order_argument.py"])],
            cwd=workspace,
            capture_output=True,
            text=True,
            check=False,
        )

    def _write_native_run(
        self,
        workspace: Path,
        *,
        selected_txt: str,
        call_count: int = 1,
    ) -> None:
        output = workspace / "tool-argument-error-output"
        fixtures = output / "fixtures"
        fixtures.mkdir(parents=True)
        for filename, content in FIXTURE_CONTENT.items():
            (fixtures / filename).write_text(content, encoding="utf-8")

        selected_content = FIXTURE_CONTENT[selected_txt].encode()
        file_info = {
            "txt": selected_txt,
            "size_bytes": len(selected_content),
            "sha256": hashlib.sha256(selected_content).hexdigest(),
            "preview": selected_content.decode().splitlines()[0],
        }
        events = []
        for sequence in range(1, call_count + 1):
            events.append(
                {
                    "sequence": sequence,
                    "type": "tool_call",
                    "expected_tool": "order",
                    "actual_tool": "order",
                    "tool_matches": True,
                    "expected_arguments": {"txt": "a.txt"},
                    "actual_arguments": {"txt": selected_txt},
                    "argument_schema_valid": True,
                    "argument_value_matches": selected_txt == "a.txt",
                    "tool_succeeded": True,
                    "file_info": file_info,
                }
            )
        (output / "events.jsonl").write_text(
            "".join(json.dumps(event) + "\n" for event in events),
            encoding="utf-8",
        )
        result = {
            "schema_version": 1,
            "completed": True,
            "call_count": call_count,
            **events[-1],
        }
        (output / "result.json").write_text(
            json.dumps(result) + "\n",
            encoding="utf-8",
        )

    def test_registry_keeps_only_the_verifier_hidden(self) -> None:
        self.assertEqual(self.fault.skill_name, "ras-tool-argument-error")
        self.assertEqual(
            tuple(path.name for path in self.fault.tool_files),
            ("verify_order_argument.py",),
        )
        self.assertEqual(self.fault.agent_tool_files, ())
        self.assertIsNotNone(self.fault.authoritative_verifier_command)
        self.assertEqual(
            Path(self.fault.authoritative_verifier_command[1]).name,
            "verify_order_argument.py",
        )

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

    def test_healthy_native_a_txt_call_passes_verifier(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary)
            self._write_native_run(workspace, selected_txt="a.txt")

            verification = self._run_verifier(workspace)
            self.assertEqual(verification.returncode, 0, verification.stdout)
            self.assertIn("argument verification succeeded", verification.stdout)

    def test_native_b_txt_call_succeeds_but_fails_verifier(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary)
            self._write_native_run(workspace, selected_txt="b.txt")

            verification = self._run_verifier(workspace)
            self.assertEqual(verification.returncode, 1)
            self.assertIn(
                "tool argument mismatch: expected 'a.txt', got 'b.txt'",
                verification.stdout,
            )

    def test_verifier_rejects_more_than_one_native_order_call(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary)
            self._write_native_run(
                workspace,
                selected_txt="a.txt",
                call_count=2,
            )

            verification = self._run_verifier(workspace)
            self.assertEqual(verification.returncode, 1)
            self.assertIn("expected one native tool call", verification.stdout)


if __name__ == "__main__":
    unittest.main()
