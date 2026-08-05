import tempfile
from pathlib import Path
from unittest import TestCase

from agent_fault_injection.exceptions import ConfigurationError
from agent_fault_injection.fault_inject.ui_catalog import (
    load_fault_ui_catalog,
    resolve_fault_labels,
    resolve_fault_submodes,
)


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
        self.assertIn("route_manipulate", catalog.injection_methods)
        self.assertNotIn("skill", catalog.injection_methods)
        self.assertNotIn("file", catalog.injection_methods)
        self.assertNotIn("middleware", catalog.injection_methods)
        self.assertNotIn("tool_result", catalog.injection_methods)
        self.assertNotIn("prompt", catalog.injection_methods)
        self.assertNotIn("interception", catalog.injection_methods)
        self.assertNotIn("routing", catalog.injection_methods)
        entry = catalog.entry("ras-early-stop")
        assert entry is not None
        self.assertEqual(entry.label_zh, "提前停止")
        self.assertIsNone(entry.submodes)

    def test_builtin_multi_submodes_id_filled_from_skill(self) -> None:
        catalog = load_fault_ui_catalog()
        from agent_fault_injection.fault_inject.registry import FaultRegistry

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
            path = Path(temporary) / "fault-catalog.yaml"
            path.write_text(
                "\n".join(
                    [
                        "faults:",
                        "  - id: beta",
                        "    label_zh: 乙",
                        "  - id: alpha",
                        "    label_zh: 甲",
                        "  - id: hidden",
                        "    visible: false",
                    ]
                ),
                encoding="utf-8",
            )
            catalog = load_fault_ui_catalog(path)
            ordered = catalog.ordered_ids(["hidden", "gamma", "alpha", "beta"])
            self.assertEqual(ordered, ["beta", "alpha", "gamma"])

    def test_resolve_labels_prefer_catalog(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            catalog_path = root / "fault-catalog.yaml"
            catalog_path.write_text(
                "\n".join(
                    [
                        "faults:",
                        "  - id: demo",
                        "    label_zh: 配置中文名",
                        "    label_en: demo-en",
                    ]
                ),
                encoding="utf-8",
            )
            skill = root / "SKILL.md"
            skill.write_text(
                "---\nname: demo\ndescription: d\n---\n\n# Skill Title\n",
                encoding="utf-8",
            )
            catalog = load_fault_ui_catalog(catalog_path)
            zh, en = resolve_fault_labels(
                fault_id="demo",
                skill_file=skill,
                catalog=catalog,
            )
            self.assertEqual(zh, "配置中文名")
            self.assertEqual(en, "demo-en")

    def test_resolve_submodes_prefer_catalog(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            catalog_path = root / "fault-catalog.yaml"
            catalog_path.write_text(
                "\n".join(
                    [
                        "faults:",
                        "  - id: demo",
                        "    submodes:",
                        "      - name: 配置子模式",
                        "        description: 来自 YAML",
                        "      - name: 隐藏子模式",
                        "        visible: false",
                    ]
                ),
                encoding="utf-8",
            )
            skill = root / "SKILL.md"
            skill.write_text(
                "\n".join(
                    [
                        "---",
                        "name: demo",
                        "description: d",
                        "---",
                        "",
                        "# Demo",
                        "",
                        "## 场景1：Skill 子模式",
                        "",
                        "## 场景2：另一个",
                    ]
                ),
                encoding="utf-8",
            )
            catalog = load_fault_ui_catalog(catalog_path)
            submodes = resolve_fault_submodes(
                fault_id="demo",
                skill_file=skill,
                catalog=catalog,
            )
            self.assertEqual(
                submodes,
                [{"id": "1", "name": "配置子模式", "description": "来自 YAML"}],
            )

    def test_resolve_submodes_fallback_to_skill(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            catalog_path = root / "fault-catalog.yaml"
            catalog_path.write_text(
                "faults:\n  - id: demo\n    label_zh: Demo\n",
                encoding="utf-8",
            )
            skill = root / "SKILL.md"
            skill.write_text(
                "\n".join(
                    [
                        "---",
                        "name: demo",
                        "description: d",
                        "---",
                        "",
                        "# Demo",
                        "",
                        "## 场景1：Skill 子模式",
                    ]
                ),
                encoding="utf-8",
            )
            catalog = load_fault_ui_catalog(catalog_path)
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
            skill = root / "SKILL.md"
            skill.write_text(
                "---\nname: orphan\ndescription: d\n---\n\n# Orphan Title\n",
                encoding="utf-8",
            )
            catalog = load_fault_ui_catalog(root / "missing.yaml")
            zh, en = resolve_fault_labels(
                fault_id="orphan",
                skill_file=skill,
                catalog=catalog,
            )
            self.assertEqual(zh, "Orphan Title")
            self.assertEqual(en, "orphan")

    def test_rejects_duplicate_ids(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "fault-catalog.yaml"
            path.write_text(
                "\n".join(
                    [
                        "faults:",
                        "  - id: demo",
                        "  - id: demo",
                    ]
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ConfigurationError, "Duplicate"):
                load_fault_ui_catalog(path)
