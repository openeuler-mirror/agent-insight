"""Contract tests for OpenCode plugin skill-name normalization.

The pure function below MUST stay in sync with normalizeSkillName in
agent_fault_injection/platform_adapters/opencode/plugin/agent-fault-injection.ts.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path


def normalize_skill_name(name: str) -> str:
    """Mirror of agent-fault-injection.ts normalizeSkillName."""

    trimmed = name.strip()
    no_leading = re.sub(r"^/+", "", trimmed)
    parts = [part for part in re.split(r"[/\\]", no_leading) if part]
    return parts[-1] if parts else ""


PLUGIN_PATH = (
    Path(__file__).resolve().parents[2]
    / "platform_adapters"
    / "opencode"
    / "plugin"
    / "agent-fault-injection.ts"
)


class SkillNameNormalizeTests(unittest.TestCase):
    def test_normalize_cases(self) -> None:
        cases = [
            ("ras-step-order-error", "ras-step-order-error"),
            ("/ras-step-order-error", "ras-step-order-error"),
            ("  /ras-step-order-error  ", "ras-step-order-error"),
            ("skills/ras-step-order-error", "ras-step-order-error"),
            ("//ras-step-order-error", "ras-step-order-error"),
            (r"skills\ras-step-order-error", "ras-step-order-error"),
        ]
        for raw, expected in cases:
            with self.subTest(raw=raw):
                self.assertEqual(normalize_skill_name(raw), expected)

    def test_failed_run_variant_matches_fault_skill(self) -> None:
        self.assertEqual(
            normalize_skill_name("/ras-step-order-error"),
            normalize_skill_name("ras-step-order-error"),
        )

    def test_plugin_defines_and_uses_normalize_skill_name(self) -> None:
        self.assertTrue(PLUGIN_PATH.is_file(), f"missing plugin: {PLUGIN_PATH}")
        source = PLUGIN_PATH.read_text(encoding="utf-8")
        self.assertIn("function normalizeSkillName(", source)
        self.assertIn("normalizeSkillName(skillName)", source)
        self.assertIn("normalizeSkillName(faultSkill)", source)
        self.assertIn("rawSkillName", source)
        self.assertIn("normalizedSkillName", source)
        # Activation must not rely on raw strict equality alone.
        self.assertNotRegex(
            source,
            r"if\s*\(\s*skillName\s*===\s*faultSkill\s*\)",
        )

    def test_plugin_imports_message_role_from_rewrite_runtime(self) -> None:
        self.assertTrue(PLUGIN_PATH.is_file(), f"missing plugin: {PLUGIN_PATH}")
        source = PLUGIN_PATH.read_text(encoding="utf-8")
        self.assertIn("messageRole", source)
        self.assertRegex(
            source,
            r'from\s+["\']\.\./lib/rewrite-runtime["\']',
        )
        self.assertRegex(
            source,
            r"import\s*\{[^}]*\bmessageRole\b[^}]*\}\s*from\s*[\"']\.\./lib/rewrite-runtime[\"']",
        )
        runtime = (
            Path(__file__).resolve().parents[2]
            / "platform_adapters"
            / "opencode"
            / "lib"
            / "rewrite-runtime.ts"
        )
        self.assertTrue(runtime.is_file())
        runtime_source = runtime.read_text(encoding="utf-8")
        self.assertIn("export function messageRole(", runtime_source)


if __name__ == "__main__":
    unittest.main()
