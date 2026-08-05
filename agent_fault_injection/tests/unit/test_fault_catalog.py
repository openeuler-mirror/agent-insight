import json
import tempfile
from pathlib import Path
from unittest import TestCase

from agent_fault_injection.exceptions import (
    ConfigurationError,
    InstallationConflictError,
)
from agent_fault_injection.fault_inject.catalog import add_fault
from agent_fault_injection.fault_inject.registry import FaultRegistry


class FaultCatalogTests(TestCase):
    def _skill(self, root: Path) -> Path:
        skill = root / "source" / "SKILL.md"
        skill.parent.mkdir()
        skill.write_text(
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
        return skill

    def test_adds_fault_and_registry_discovers_it(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            skills_root = root / "skills"

            added = add_fault(
                name="tool-timeout",
                skill_file=self._skill(root),
                skills_root=skills_root,
            )
            discovered = FaultRegistry(skills_root).get("tool-timeout")

            self.assertEqual(added, discovered)
            self.assertEqual(discovered.skill_name, "ras-tool-timeout")
            self.assertEqual(
                discovered.description,
                "Inject one controlled tool timeout.",
            )
            self.assertTrue((skills_root / "tool-timeout" / "SKILL.md").is_file())
            self.assertFalse(
                (skills_root / "tool-timeout" / "fault.json").exists()
            )

    def test_add_fault_overrides_description_in_skill(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            skills_root = root / "skills"

            added = add_fault(
                name="tool-timeout",
                skill_file=self._skill(root),
                description="自定义超时故障说明",
                skills_root=skills_root,
            )

            self.assertEqual(added.description, "自定义超时故障说明")
            rediscovered = FaultRegistry(skills_root).get("tool-timeout")
            self.assertEqual(rediscovered.description, "自定义超时故障说明")

    def test_rejects_invalid_fault_name(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaisesRegex(ConfigurationError, "lowercase"):
                add_fault(
                    name="Tool Timeout",
                    skill_file=self._skill(root),
                    skills_root=root / "skills",
                )

    def test_refuses_to_overwrite_existing_fault(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            skills_root = root / "skills"
            skill = self._skill(root)
            add_fault(
                name="tool-timeout",
                skill_file=skill,
                skills_root=skills_root,
            )

            with self.assertRaises(InstallationConflictError):
                add_fault(
                    name="tool-timeout",
                    skill_file=skill,
                    skills_root=skills_root,
                )

    def test_loads_fault_from_skill_frontmatter(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fault_dir = root / "skills" / "demo-fault"
            fault_dir.mkdir(parents=True)
            (fault_dir / "SKILL.md").write_text(
                "\n".join(
                    [
                        "---",
                        "name: demo-fault",
                        "description: 来自 SKILL 的中文说明",
                        "---",
                        "",
                        "# Demo",
                    ]
                ),
                encoding="utf-8",
            )

            fault = FaultRegistry(root / "skills").get("demo-fault")
            self.assertEqual(fault.name, "demo-fault")
            self.assertEqual(fault.skill_name, "demo-fault")
            self.assertEqual(fault.description, "来自 SKILL 的中文说明")
            self.assertEqual(fault.tool_files, ())
            self.assertIsNone(fault.authoritative_verifier_command)

    def test_rejects_manifest_tool_that_does_not_exist(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fault_dir = root / "skills" / "tool-timeout"
            fault_dir.mkdir(parents=True)
            skill = self._skill(root)
            (fault_dir / "SKILL.md").write_text(
                skill.read_text(encoding="utf-8"),
                encoding="utf-8",
            )
            (fault_dir / "fault.json").write_text(
                json.dumps(
                    {
                        "name": "tool-timeout",
                        "skill_name": "ras-tool-timeout",
                        "category": "tool",
                        "description": "Inject one controlled timeout.",
                        "tools": ["missing.py"],
                    }
                ),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(
                ConfigurationError,
                "Fault tool does not exist",
            ):
                FaultRegistry(root / "skills")

    def test_rejects_verifier_reference_to_undeclared_tool(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fault_dir = root / "skills" / "tool-timeout"
            scripts_dir = fault_dir / "scripts"
            fault_dir.mkdir(parents=True)
            scripts_dir.mkdir(parents=True)
            skill = self._skill(root)
            (fault_dir / "SKILL.md").write_text(
                skill.read_text(encoding="utf-8"),
                encoding="utf-8",
            )
            (scripts_dir / "probe.sh").write_text(
                "#!/bin/sh\nexit 0\n",
                encoding="utf-8",
            )
            (fault_dir / "fault.json").write_text(
                json.dumps(
                    {
                        "name": "tool-timeout",
                        "skill_name": "ras-tool-timeout",
                        "category": "tool",
                        "description": "Inject one controlled timeout.",
                        "tools": ["probe.sh"],
                        "authoritative_verifier": {
                            "command": ["{tool:missing.sh}"],
                        },
                    }
                ),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(
                ConfigurationError,
                "references undeclared tool",
            ):
                FaultRegistry(root / "skills")

    def test_resolves_non_python_authoritative_tool_command(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fault_dir = root / "skills" / "tool-timeout"
            scripts_dir = fault_dir / "scripts"
            fault_dir.mkdir(parents=True)
            scripts_dir.mkdir(parents=True)
            skill = self._skill(root)
            (fault_dir / "SKILL.md").write_text(
                skill.read_text(encoding="utf-8"),
                encoding="utf-8",
            )
            probe = scripts_dir / "probe.sh"
            probe.write_text(
                "#!/bin/sh\nexit 0\n",
                encoding="utf-8",
            )
            (fault_dir / "fault.json").write_text(
                json.dumps(
                    {
                        "name": "tool-timeout",
                        "skill_name": "ras-tool-timeout",
                        "category": "tool",
                        "description": "Inject one controlled timeout.",
                        "tools": ["probe.sh"],
                        "authoritative_verifier": {
                            "command": [
                                "{tool:probe.sh}",
                                "--mode",
                                "check",
                            ],
                            "timeout_seconds": 7,
                        },
                    }
                ),
                encoding="utf-8",
            )

            fault = FaultRegistry(root / "skills").get("tool-timeout")

            self.assertEqual(
                fault.authoritative_verifier_command,
                (str(probe.resolve()), "--mode", "check"),
            )
            self.assertEqual(
                fault.authoritative_verifier_timeout_seconds,
                7,
            )
