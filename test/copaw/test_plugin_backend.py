import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from copaw import cli
from copaw._plugin_assets import backend
from copaw.config import CollectorConfig


class _FakeCollector:
    def __init__(self, config: CollectorConfig) -> None:
        self.config = config
        self.closed = False

    def close(self) -> None:
        self.closed = True


class PluginBackendTest(unittest.TestCase):
    def tearDown(self) -> None:
        backend._collector = None

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
            log_file = Path(tmp) / "copaw.log"
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
