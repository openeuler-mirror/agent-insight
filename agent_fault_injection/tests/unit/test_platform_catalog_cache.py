"""Unit tests for platform agent/model catalog caching."""

from __future__ import annotations

from unittest import TestCase
from unittest.mock import patch

from agent_fault_injection.web import models_catalog


class PlatformCatalogCacheTests(TestCase):
    def setUp(self) -> None:
        models_catalog.clear_platform_catalog_cache()

    def tearDown(self) -> None:
        models_catalog.clear_platform_catalog_cache()

    def test_agents_cached_until_refresh(self) -> None:
        payload = {
            "platform": "opencode",
            "default": "build",
            "agents": [{"id": "build", "name": "build"}],
        }
        with patch(
            "agent_fault_injection.platform_adapters.opencode.adapter.OpenCodeAdapter.list_agents",
            return_value=payload,
        ) as mocked:
            first = models_catalog.list_platform_agents("opencode")
            second = models_catalog.list_platform_agents("opencode")
            self.assertEqual(mocked.call_count, 1)
            self.assertFalse(first.get("cached"))
            self.assertTrue(second.get("cached"))
            self.assertEqual(second["agents"], payload["agents"])

            third = models_catalog.list_platform_agents("opencode", refresh=True)
            self.assertEqual(mocked.call_count, 2)
            self.assertFalse(third.get("cached"))

    def test_models_cached_until_refresh(self) -> None:
        payload = {
            "platform": "opencode",
            "default": None,
            "models": [
                {
                    "id": "deepseek/deepseek-chat",
                    "providerID": "deepseek",
                    "modelID": "deepseek-chat",
                    "name": "deepseek-chat",
                    "default": False,
                }
            ],
        }
        with patch(
            "agent_fault_injection.platform_adapters.opencode.adapter.OpenCodeAdapter.list_models",
            return_value=payload,
        ) as mocked:
            first = models_catalog.list_platform_models("opencode")
            second = models_catalog.list_platform_models("opencode")
            self.assertEqual(mocked.call_count, 1)
            self.assertFalse(first.get("cached"))
            self.assertTrue(second.get("cached"))

            models_catalog.list_platform_models("opencode", refresh=True)
            self.assertEqual(mocked.call_count, 2)

    def test_unsupported_platform_stub_is_cached(self) -> None:
        first = models_catalog.list_platform_agents("openclaw")
        second = models_catalog.list_platform_agents("openclaw")
        self.assertEqual(first["agents"], [])
        self.assertFalse(first.get("cached"))
        self.assertTrue(second.get("cached"))
