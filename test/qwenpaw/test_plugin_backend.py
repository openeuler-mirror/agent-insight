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

import importlib.util
import tempfile
import unittest
import shutil
import sys
from pathlib import Path
from unittest.mock import patch

from qwenpaw_insight import cli
from qwenpaw_insight._plugin_assets import backend
from qwenpaw_insight.config import CollectorConfig


class _FakeCollector:
    def __init__(self, config: CollectorConfig) -> None:
        self.config = config
        self.closed = False

    def close(self) -> None:
        self.closed = True


class PluginBackendTest(unittest.TestCase):
    def tearDown(self) -> None:
        backend._collector = None

    def test_installed_backend_bootstraps_its_own_package_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            plugin_dir = Path(tmp) / "agent-insight-qwenpaw"
            source_root = Path(__file__).resolve().parents[2] / "scripts" / "qwenpaw-collector"
            asset_root = source_root / "qwenpaw_insight" / "_plugin_assets"
            shutil.copytree(
                source_root / "qwenpaw_insight",
                plugin_dir / "qwenpaw_insight",
                ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".pytest_cache"),
            )
            shutil.copy2(asset_root / "backend.py", plugin_dir / "backend.py")

            backend_name = "temp_qwenpaw_backend_for_bootstrap_test"
            saved_sys_path = sys.path[:]
            saved_modules = {
                name: sys.modules.pop(name)
                for name in list(sys.modules)
                if name == "qwenpaw_insight" or name.startswith("qwenpaw_insight.")
            }
            try:
                sys.path[:] = [
                    entry
                    for entry in saved_sys_path
                    if Path(entry).resolve() != source_root.resolve()
                ]
                spec = importlib.util.spec_from_file_location(
                    backend_name,
                    plugin_dir / "backend.py",
                )
                self.assertIsNotNone(spec)
                self.assertIsNotNone(spec.loader)
                module = importlib.util.module_from_spec(spec)
                sys.modules[backend_name] = module
                spec.loader.exec_module(module)

                self.assertIsNotNone(getattr(module, "plugin", None))
                self.assertIn(str(plugin_dir), sys.path)
            finally:
                sys.modules.pop(backend_name, None)
                sys.path[:] = saved_sys_path
                sys.modules.update(saved_modules)

    def test_explicit_plugin_removal_cleans_spool(self):
        with tempfile.TemporaryDirectory() as tmp:
            spool = Path(tmp) / "spool"
            spool.mkdir()
            (spool / "pending.json").write_text("{}", encoding="utf-8")
            collector = _FakeCollector(CollectorConfig(spool_dir=str(spool)))
            backend._collector = collector

            with patch.object(backend.patches, "uninstall_all") as uninstall_all:
                backend._uninstall(delete_files=True)

            uninstall_all.assert_called_once()
            self.assertTrue(collector.closed)
            self.assertFalse(spool.exists())

    def test_reload_keeps_spool(self):
        with tempfile.TemporaryDirectory() as tmp:
            spool = Path(tmp) / "spool"
            spool.mkdir()
            collector = _FakeCollector(CollectorConfig(spool_dir=str(spool)))
            backend._collector = collector

            with patch.object(backend.patches, "uninstall_all"):
                backend._uninstall(delete_files=False)

            self.assertTrue(spool.exists())

    def test_cli_uninstall_remove_log_handles_missing_plugin(self):
        with tempfile.TemporaryDirectory() as tmp:
            plugins_dir = Path(tmp) / "plugins"
            log_file = Path(tmp) / "qwenpaw.log"
            log_file.write_text("old log", encoding="utf-8")

            args = type(
                "Args",
                (),
                {
                    "plugins_dir": str(plugins_dir),
                    "keep_spool": False,
                    "remove_log": True,
                },
            )()

            with patch.object(
                cli,
                "load_config",
                return_value=CollectorConfig(log_file=str(log_file)),
            ):
                code = cli.cmd_uninstall(args)

            self.assertEqual(code, 0)
            self.assertFalse(log_file.exists())


if __name__ == "__main__":
    unittest.main()
