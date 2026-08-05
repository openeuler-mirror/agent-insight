"""Unit tests for shared structural injection tools."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path
from unittest import TestCase

from agent_fault_injection.fault_inject.catalog import load_fault_definition
from agent_fault_injection.fault_inject.installer import InstallSession
from agent_fault_injection.fault_inject.injection_tools import (
    InjectionContext,
    apply_injection_plan,
)
from agent_fault_injection.fault_inject.injection_tools.file_ops import (
    file_delete,
    file_delete_section,
    file_replace_text,
    file_truncate,
    file_write,
)
from agent_fault_injection.fault_inject.models import InjectionStep
from agent_fault_injection.fault_inject.registry import FaultRegistry


class InjectionToolsTests(TestCase):
    def _ctx(
        self,
        root: Path,
        *,
        submode: str | None = "1",
        assets_root: Path | None = None,
    ) -> tuple[InjectionContext, InstallSession]:
        workspace = root / "workspace"
        artifacts = root / "artifacts"
        events = root / "events.jsonl"
        workspace.mkdir()
        artifacts.mkdir()
        installation = InstallSession()
        ctx = InjectionContext(
            workspace=workspace,
            artifacts_dir=artifacts,
            events_file=events,
            installation=installation,
            submode=submode,
            assets_root=assets_root,
        )
        return ctx, installation

    def test_file_write_delete_and_cleanup(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            assets = root / "assets"
            assets.mkdir()
            (assets / "MEMORY.md").write_text("# seed\n", encoding="utf-8")
            ctx, installation = self._ctx(root, assets_root=assets)

            file_write(
                ctx,
                {"path": "MEMORY.md", "from_asset": "MEMORY.md"},
            )
            target = ctx.workspace / "MEMORY.md"
            self.assertTrue(target.is_file())
            file_delete(ctx, {"path": "MEMORY.md"})
            self.assertFalse(target.exists())

            installation.cleanup()
            self.assertFalse(target.exists())

    def test_delete_section_and_replace_truncate(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            ctx, _installation = self._ctx(root)
            text = "# Title\n\n## 约束\n- keep\n\n## 背景\nok\n"
            file_write(ctx, {"path": "MEMORY.md", "content": text})
            file_delete_section(
                ctx,
                {"path": "MEMORY.md", "heading": "## 约束"},
            )
            after = (ctx.workspace / "MEMORY.md").read_text(encoding="utf-8")
            self.assertNotIn("## 约束", after)
            self.assertIn("## 背景", after)

            file_replace_text(
                ctx,
                {
                    "path": "MEMORY.md",
                    "from": "ok",
                    "to": "poisoned",
                },
            )
            self.assertIn(
                "poisoned",
                (ctx.workspace / "MEMORY.md").read_text(encoding="utf-8"),
            )

            file_truncate(ctx, {"path": "MEMORY.md", "bytes": 5})
            self.assertEqual(
                len((ctx.workspace / "MEMORY.md").read_bytes()),
                5,
            )

    def test_memory_file_loss_plan_submode_1(self) -> None:
        fault = FaultRegistry().get("memory-file-loss")
        self.assertEqual(fault.injection_method, "file_tamper")
        self.assertTrue(fault.injection_plan)
        self.assertIsNotNone(fault.assets_dir)

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            ctx, installation = self._ctx(root, submode="1")
            apply_injection_plan(fault, ctx)

            self.assertFalse((ctx.workspace / "MEMORY.md").exists())
            before = ctx.artifacts_dir / "injection" / "before_mut.md"
            after = ctx.artifacts_dir / "injection" / "after_mut.md"
            self.assertTrue(before.is_file())
            self.assertTrue(after.is_file())
            self.assertIn("CONSTRAINT_TOKEN", before.read_text(encoding="utf-8"))
            self.assertEqual(after.read_text(encoding="utf-8"), "")

            events = [
                json.loads(line)
                for line in ctx.events_file.read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            types = {event["type"] for event in events}
            self.assertIn("fault.injection.applied", types)
            self.assertIn("memory.fault.injected", types)

            installation.cleanup()
            self.assertFalse((ctx.workspace / "MEMORY.md").exists())

    def test_memory_file_loss_plan_submode_2(self) -> None:
        fault = FaultRegistry().get("memory-file-loss")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            ctx, _installation = self._ctx(root, submode="2")
            apply_injection_plan(fault, ctx)
            text = (ctx.workspace / "MEMORY.md").read_text(encoding="utf-8")
            self.assertNotIn("## 约束", text)
            self.assertIn("## 背景", text)

    def test_scripts_directory_resolved_for_builtin_fault(self) -> None:
        fault = FaultRegistry().get("unverified-success")
        self.assertTrue(fault.tool_files)
        for path in fault.tool_files:
            self.assertEqual(path.parent.name, "scripts")
            self.assertTrue(path.is_file())

    def test_load_fault_definition_scripts_path(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fault_dir = root / "demo"
            scripts = fault_dir / "scripts"
            scripts.mkdir(parents=True)
            (fault_dir / "SKILL.md").write_text(
                "\n".join(
                    [
                        "---",
                        "name: demo",
                        "description: demo fault",
                        "---",
                        "",
                        "# Demo",
                    ]
                ),
                encoding="utf-8",
            )
            (scripts / "helper.py").write_text("print(1)\n", encoding="utf-8")
            (fault_dir / "fault.json").write_text(
                json.dumps(
                    {
                        "name": "demo",
                        "skill_name": "demo",
                        "category": "test",
                        "description": "demo fault",
                        "tools": ["helper.py"],
                    }
                ),
                encoding="utf-8",
            )
            fault = load_fault_definition(fault_dir)
            self.assertEqual(fault.tool_files[0].name, "helper.py")
            self.assertEqual(fault.tool_files[0].parent.name, "scripts")

    def test_when_submode_filters_steps(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            ctx, _installation = self._ctx(root, submode="1")
            from agent_fault_injection.fault_inject.models import FaultDefinition

            fault = FaultDefinition(
                name="x",
                skill_name="x",
                skill_file=root / "SKILL.md",
                description="x",
                injection_plan=(
                    InjectionStep(
                        op="file.write",
                        args=(("path", "a.txt"), ("content", "one")),
                        when_submode="1",
                    ),
                    InjectionStep(
                        op="file.write",
                        args=(("path", "b.txt"), ("content", "two")),
                        when_submode="2",
                    ),
                ),
            )
            apply_injection_plan(fault, ctx)
            self.assertTrue((ctx.workspace / "a.txt").is_file())
            self.assertFalse((ctx.workspace / "b.txt").exists())
