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
