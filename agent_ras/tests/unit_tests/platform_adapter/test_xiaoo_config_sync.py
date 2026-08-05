from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from platform_adapter.xiaoo.config_sync import (
    load_hello_config_from_ras_config,
    merge_capability_into_local_ras_config,
    resolve_ras_config_url,
    sync_capability_config_from_insight,
)


class XiaooConfigSyncTests(unittest.TestCase):
    def test_resolve_ras_config_url_rewrites_events(self) -> None:
        self.assertEqual(
            resolve_ras_config_url(
                {"events_url": "http://127.0.0.1:3000/api/ingest/ras-events"}
            ),
            "http://127.0.0.1:3000/api/ingest/ras-config",
        )

    def test_merge_preserves_service_and_insight(self) -> None:
        local = {
            "agent_ras": {
                "enabled": True,
                "service": {"python": "/keep/me"},
                "insight": {"api_key": "k", "events_url": "http://x/ras-events"},
                "ras_config_revision": 1,
            }
        }
        body = {
            "enabled": False,
            "detectors": {
                "repeat_tool": {"enabled": True, "warning_threshold": 6},
                "llm_thinking_loop": {"detection_start_chars": 777},
            },
            "recovery": {"notify_user_on_warning": False},
        }
        merged = merge_capability_into_local_ras_config(local, body, 3)
        ras = merged["agent_ras"]
        self.assertEqual(ras["enabled"], False)
        self.assertEqual(ras["service"]["python"], "/keep/me")
        self.assertEqual(ras["insight"]["api_key"], "k")
        self.assertEqual(ras["ras_config_revision"], 3)
        self.assertEqual(ras["detectors"]["llm_thinking_loop"]["detection_start_chars"], 777)
        self.assertEqual(ras["llm_thinking_loop"]["detection_start_chars"], 777)

    def test_sync_merges_when_revision_ahead(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            config_path = home / "config.json"
            config_path.write_text(
                json.dumps(
                    {
                        "agent_ras": {
                            "enabled": True,
                            "service": {"python": "/keep"},
                            "insight": {
                                "enabled": True,
                                "events_url": "http://example.test/api/ingest/ras-events",
                                "api_key": "test-key",
                            },
                            "ras_config_revision": 1,
                        }
                    }
                ),
                encoding="utf-8",
            )

            def fetch(_url: str, _headers: dict[str, str]) -> dict:
                return {
                    "syncEnabled": True,
                    "revision": 4,
                    "config": {
                        "enabled": False,
                        "detectors": {
                            "repeat_tool": {"enabled": True, "warning_threshold": 5},
                            "llm_thinking_loop": {"detection_start_chars": 500},
                        },
                        "recovery": {"notify_user_on_warning": False},
                    },
                }

            result = sync_capability_config_from_insight(
                ras_home=home,
                fetch_impl=fetch,
                force=True,
            )
            self.assertTrue(result["applied"])
            self.assertEqual(result["revision"], 4)
            saved = json.loads(config_path.read_text(encoding="utf-8"))
            self.assertEqual(saved["agent_ras"]["enabled"], False)
            self.assertEqual(saved["agent_ras"]["service"]["python"], "/keep")
            self.assertEqual(
                saved["agent_ras"]["detectors"]["llm_thinking_loop"]["detection_start_chars"],
                500,
            )

    def test_sync_skips_when_disabled(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            (home / "config.json").write_text(
                json.dumps(
                    {
                        "agent_ras": {
                            "insight": {
                                "enabled": True,
                                "events_url": "http://example.test/api/ingest/ras-events",
                                "api_key": "k",
                            }
                        }
                    }
                ),
                encoding="utf-8",
            )
            result = sync_capability_config_from_insight(
                ras_home=home,
                fetch_impl=lambda *_a, **_k: {
                    "syncEnabled": False,
                    "revision": 9,
                    "config": None,
                },
                force=True,
            )
            self.assertFalse(result["applied"])
            self.assertEqual(result["reason"], "sync_disabled_or_empty")

    def test_hello_config_forces_no_l3(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            (home / "config.json").write_text(
                json.dumps(
                    {
                        "agent_ras": {
                            "detectors": {
                                "llm_thinking_loop": {
                                    "detection_start_chars": 888,
                                    "semantic_content_enabled": True,
                                },
                                "repeat_tool": {"warning_threshold": 7},
                            },
                            "recovery": {"notify_user_on_warning": False},
                        }
                    }
                ),
                encoding="utf-8",
            )
            env = {
                k: v
                for k, v in dict(**__import__("os").environ).items()
                if k
                not in {
                    "RAS_DETECTION_START_CHARS",
                    "RAS_WINDOW_MAX_CHARS",
                    "RAS_LOOP_REPEAT_THRESHOLD",
                }
            }
            with mock.patch.dict("os.environ", env, clear=True):
                cfg = load_hello_config_from_ras_config(home)
            self.assertEqual(cfg["detection_start_chars"], 888)
            self.assertEqual(cfg["semantic_content_enabled"], False)
            self.assertEqual(cfg["repeat_tool"]["warning_threshold"], 7)
            self.assertEqual(cfg["notify_user_on_warning"], False)


if __name__ == "__main__":
    unittest.main()
