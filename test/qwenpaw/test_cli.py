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

import json
import tempfile
import unittest
from pathlib import Path

from qwenpaw_insight.cli import main


class CliTest(unittest.TestCase):
    def test_install_and_uninstall(self):
        with tempfile.TemporaryDirectory() as tmp:
            plugins_dir = str(Path(tmp) / "plugins")
            spool = Path(tmp) / "spool"
            code = main(["install", "--plugins-dir", plugins_dir, "--host", "http://localhost:3000", "--api-key", "wi_test"])
            self.assertEqual(code, 0)
            target = Path(plugins_dir) / "agent-insight-qwenpaw"
            self.assertTrue((target / "plugin.json").exists())
            self.assertTrue((target / "backend.py").exists())
            self.assertTrue((target / "qwenpaw_insight" / "sanitize.py").exists())
            config = (target / "config.json").read_text(encoding="utf-8")
            self.assertIn("/api/ingest/otel/v1/traces", config)
            self.assertIn("wi_test", config)
            # Point the installed config at a temporary spool so uninstall
            # never touches the real ~/.agent-insight directory.
            raw = json.loads(config)
            raw["spool_dir"] = str(spool)
            (target / "config.json").write_text(json.dumps(raw), encoding="utf-8")
            spool.mkdir(parents=True)
            (spool / "spans.json").write_text("{}", encoding="utf-8")

            code = main(["uninstall", "--plugins-dir", plugins_dir])
            self.assertEqual(code, 0)
            self.assertFalse(target.exists())
            self.assertFalse(spool.exists())

    def test_uninstall_keeps_spool_when_config_missing(self):
        """Uninstall must not delete spool data when the plugin config is gone."""
        with tempfile.TemporaryDirectory() as tmp:
            plugins_dir = str(Path(tmp) / "plugins")
            spool = Path(tmp) / "spool"
            main(["install", "--plugins-dir", plugins_dir, "--host", "http://localhost:3000"])
            target = Path(plugins_dir) / "agent-insight-qwenpaw"
            (target / "config.json").write_text(
                json.dumps({"spool_dir": str(spool)}),
                encoding="utf-8",
            )
            spool.mkdir(parents=True)
            (spool / "spans.json").write_text("{}", encoding="utf-8")
            (target / "config.json").unlink()

            code = main(["uninstall", "--plugins-dir", plugins_dir])
            self.assertEqual(code, 0)
            self.assertFalse(target.exists())
            self.assertTrue(spool.exists())

    def test_uninstall_keep_spool(self):
        with tempfile.TemporaryDirectory() as tmp:
            plugins_dir = str(Path(tmp) / "plugins")
            spool = Path(tmp) / "spool"
            main(["install", "--plugins-dir", plugins_dir, "--host", "http://localhost:3000"])
            target = Path(plugins_dir) / "agent-insight-qwenpaw"
            spool.mkdir(parents=True)
            (spool / "spans.json").write_text("{}", encoding="utf-8")
            (target / "config.json").write_text(json.dumps({"spool_dir": str(spool)}), encoding="utf-8")

            code = main(["uninstall", "--plugins-dir", plugins_dir, "--keep-spool"])
            self.assertEqual(code, 0)
            self.assertFalse(target.exists())
            self.assertTrue(spool.exists())


if __name__ == "__main__":
    unittest.main()
