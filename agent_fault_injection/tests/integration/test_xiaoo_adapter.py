"""Integration smoke for xiaoO adapter (skipped without xiaoo binary)."""

from __future__ import annotations

import shutil
import unittest
from pathlib import Path

from agent_fault_injection.platform_adapters.xiaoo import XiaoOAdapter
from agent_fault_injection.platform_adapters.xiaoo.config_overlay import prepare_overlay


@unittest.skipUnless(shutil.which("xiaoo"), "xiaoo executable not on PATH")
class XiaoOIntegrationSmokeTests(unittest.TestCase):
    def test_overlay_and_health(self) -> None:
        adapter = XiaoOAdapter()
        health = adapter.health_check()
        self.assertTrue(health["ready"], health.get("errors"))
        root = Path("/tmp")  # overlay only; no network call
        # Ensure prepare_overlay succeeds in a real temp under adapter package.
        import tempfile

        with tempfile.TemporaryDirectory() as temporary:
            config_toml, plugin_json = prepare_overlay(
                overlay_root=Path(temporary) / "overlay"
            )
            self.assertTrue(config_toml.is_file())
            self.assertTrue(plugin_json.is_file())
