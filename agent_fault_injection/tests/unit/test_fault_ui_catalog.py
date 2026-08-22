import tempfile
from pathlib import Path
from unittest import TestCase

from agent_fault_injection.pipeline.exceptions import ConfigurationError
from agent_fault_injection.fault_inject.catalog.presentation import (
    load_fault_ui_catalog,
    resolve_fault_labels,
    resolve_fault_platforms,
    resolve_fault_submodes,
)


def _write_skill(
    root: Path,
    fault_id: str,
    *,
    metadata_lines: list[str] | None = None,
    body: str = "# Skill Title\n",
) -> Path:
    directory = root / fault_id
    directory.mkdir(parents=True)
    lines = [
        "---",
        f"name: {fault_id}",
        "description: demo description",
    ]
    if metadata_lines:
        lines.append("metadata:")
        lines.extend(f"  {line}" for line in metadata_lines)
    lines.extend(["---", "", body])
    skill = directory / "SKILL.md"
    skill.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return skill


class FaultUiCatalogTests(TestCase):
    def test_loads_builtin_catalog(self) -> None:
        catalog = load_fault_ui_catalog()
        self.assertEqual(catalog.injection_methods["skill_inject"], "Skill 注入")
        self.assertEqual(catalog.injection_methods["file_tamper"], "文件篡改")
        self.assertEqual(
            catalog.injection_methods["tool_result_tamper"], "工具结果篡改"
        )
        self.assertEqual(catalog.injection_methods["prompt_modify"], "提示词修改")
        self.assertEqual(
            catalog.injection_methods["intercept_rewrite"], "拦截改写"
        )
        self.assertNotIn("route_manipulate", catalog.injection_methods)
        self.assertNotIn("skill", catalog.injection_methods)
        entry = catalog.entry("ras-early-stop")
        assert entry is not None
        self.assertEqual(entry.label_zh, "提前停止")
        self.assertIsNone(entry.submodes)
        self.assertEqual(entry.order, 30)

    def test_builtin_multi_submodes_id_filled_from_skill(self) -> None:
        catalog = load_fault_ui_catalog()
        from agent_fault_injection.fault_inject.catalog.definition import FaultRegistry

        fault = FaultRegistry().get("thinking-dead-loop")
        submodes = resolve_fault_submodes(
            fault_id=fault.name,
            skill_file=fault.skill_file,
            catalog=catalog,
        )
        self.assertEqual(len(submodes), 3)
        self.assertEqual(submodes[0]["id"], "1")
        self.assertEqual(submodes[0]["name"], "字面重复死循环")

    def test_orders_discovered_ids(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            _write_skill(
                root,
                "beta",
                metadata_lines=["label_zh: 乙", "order: 10"],
            )
            _write_skill(
                root,
                "alpha",
                metadata_lines=["label_zh: 甲", "order: 20"],
            )
            _write_skill(
                root,
                "gamma",
                metadata_lines=["label_zh: 丙"],
            )
            catalog = load_fault_ui_catalog(root)
            ordered = catalog.ordered_ids(["gamma", "alpha", "beta"])
            self.assertEqual(ordered, ["beta", "alpha", "gamma"])

    def test_resolve_labels_prefer_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            skill = _write_skill(
                root,
                "demo",
                metadata_lines=[
                    "label_zh: 配置中文名",
                    "label_en: demo-en",
                ],
                body="# Skill Title\n",
            )
            catalog = load_fault_ui_catalog(root)
            zh, en = resolve_fault_labels(
                fault_id="demo",
                skill_file=skill,
                catalog=catalog,
            )
            self.assertEqual(zh, "配置中文名")
            self.assertEqual(en, "demo-en")

    def test_resolve_submodes_prefer_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            skill = _write_skill(
                root,
                "demo",
                metadata_lines=[
                    "submodes:",
                    "  - name: 配置子模式",
                    "    description: 来自 metadata",
                ],
                body="\n".join(
                    [
                        "# Demo",
                        "",
                        "## 场景1：Skill 子模式",
                        "",
                        "## 场景2：另一个",
                    ]
                ),
            )
            catalog = load_fault_ui_catalog(root)
            submodes = resolve_fault_submodes(
                fault_id="demo",
                skill_file=skill,
                catalog=catalog,
            )
            self.assertEqual(
                submodes,
                [{"id": "1", "name": "配置子模式", "description": "来自 metadata"}],
            )

    def test_resolve_submodes_fallback_to_skill(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            skill = _write_skill(
                root,
                "demo",
                metadata_lines=["label_zh: Demo"],
                body="\n".join(
                    [
                        "# Demo",
                        "",
                        "## 场景1：Skill 子模式",
                    ]
                ),
            )
            catalog = load_fault_ui_catalog(root)
            submodes = resolve_fault_submodes(
                fault_id="demo",
                skill_file=skill,
                catalog=catalog,
            )
            self.assertEqual(submodes[0]["id"], "1")
            self.assertEqual(submodes[0]["name"], "Skill 子模式")

    def test_resolve_labels_fallback_to_skill_title(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            skill = _write_skill(
                root,
                "orphan",
                body="# Orphan Title\n",
            )
            catalog = load_fault_ui_catalog(root)
            zh, en = resolve_fault_labels(
                fault_id="orphan",
                skill_file=skill,
                catalog=catalog,
            )
            self.assertEqual(zh, "Orphan Title")
            self.assertEqual(en, "orphan")

    def test_platforms_always_default(self) -> None:
        platforms = resolve_fault_platforms(fault_id="tool-argument-error")
        self.assertEqual(platforms, ["opencode", "xiaoo"])

    def test_rejects_forbidden_metadata_keys(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            _write_skill(
                root,
                "demo",
                metadata_lines=["platforms: [opencode]", "label_zh: Demo"],
            )
            with self.assertRaisesRegex(ConfigurationError, "platforms"):
                load_fault_ui_catalog(root)
