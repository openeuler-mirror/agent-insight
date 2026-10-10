"""Unit tests for ``platform inventory --json`` CLI shape."""

from __future__ import annotations

import json
from contextlib import redirect_stdout
from io import StringIO
from unittest import TestCase
from unittest.mock import patch

from agent_fault_injection.cli import (
    _normalize_agent_rows,
    _normalize_model_rows,
    build_platform_inventory,
    cli,
)


class PlatformInventoryCliTests(TestCase):
    def test_normalize_agent_and_model_rows(self) -> None:
        agents = _normalize_agent_rows(
            [
                {"id": "build", "name": "build", "mode": "primary"},
                {"name": "plan"},
                {"id": ""},
                "skip-me",
            ]
        )
        self.assertEqual(
            agents,
            [
                {"id": "build", "name": "build", "label": "build", "mode": "primary"},
                {"id": "plan", "name": "plan", "label": "plan"},
            ],
        )
        models = _normalize_model_rows(
            [
                {
                    "id": "minimax/m1",
                    "providerID": "minimax",
                    "modelID": "m1",
                    "name": "M1",
                    "default": True,
                },
                {"id": ""},
            ]
        )
        self.assertEqual(
            models,
            [
                {
                    "id": "minimax/m1",
                    "name": "M1",
                    "label": "M1",
                    "default": True,
                    "providerID": "minimax",
                    "modelID": "m1",
                }
            ],
        )

    def test_build_platform_inventory_not_ready_skips_list(self) -> None:
        class FakeAdapter:
            name = "opencode"

            def health_check(self):
                return {"ready": False, "errors": ["opencode executable not found on PATH"]}

            def list_agents(self):
                raise AssertionError("list_agents must not run when not ready")

            def list_models(self):
                raise AssertionError("list_models must not run when not ready")

        class FakeRegistry:
            def get(self, name: str):
                self.last = name
                return FakeAdapter()

        with (
            patch(
                "agent_fault_injection.platform_adapters.registry.PlatformAdapterRegistry",
                FakeRegistry,
            ),
            patch("shutil.which", return_value=None),
        ):
            payload = build_platform_inventory()

        for name in ("opencode", "xiaoo"):
            platform = payload["platforms"][name]
            self.assertFalse(platform["ready"])
            self.assertEqual(platform["agents"], [])
            self.assertEqual(platform["models"], [])
            self.assertIn("not found", platform["note"])

    def test_build_platform_inventory_ready_maps_catalog(self) -> None:
        class FakeAdapter:
            name = "opencode"

            def health_check(self):
                return {"ready": True, "errors": []}

            def list_agents(self):
                return {
                    "agents": [
                        {"id": "build", "name": "build"},
                        {"id": "custom-agent", "name": "custom-agent"},
                    ],
                    "note": "Showing usable agents",
                }

            def list_models(self):
                return {
                    "models": [
                        {
                            "id": "minimax/m1",
                            "providerID": "minimax",
                            "modelID": "m1",
                            "name": "m1",
                            "default": True,
                        }
                    ]
                }

        class FakeRegistry:
            def get(self, name: str):
                return FakeAdapter()

        with (
            patch(
                "agent_fault_injection.platform_adapters.registry.PlatformAdapterRegistry",
                FakeRegistry,
            ),
            patch("shutil.which", return_value="/usr/bin/opencode"),
        ):
            payload = build_platform_inventory()

        oc = payload["platforms"]["opencode"]
        self.assertTrue(oc["ready"])
        self.assertEqual(oc["executable"], "/usr/bin/opencode")
        self.assertEqual(
            [row["id"] for row in oc["agents"]],
            ["build", "custom-agent"],
        )
        self.assertEqual(oc["models"][0]["id"], "minimax/m1")
        self.assertIn("Showing usable agents", oc["note"])

    def test_cli_platform_inventory_json(self) -> None:
        fake = {
            "platforms": {
                "opencode": {
                    "ready": True,
                    "executable": "/bin/opencode",
                    "agents": [{"id": "build", "name": "build", "label": "build"}],
                    "models": [],
                },
                "xiaoo": {
                    "ready": False,
                    "executable": None,
                    "agents": [],
                    "models": [],
                    "note": "xiaoo executable not found on PATH",
                },
            }
        }
        out = StringIO()
        with (
            patch(
                "agent_fault_injection.cli.build_platform_inventory",
                return_value=fake,
            ),
            redirect_stdout(out),
        ):
            code = cli(["platform", "inventory", "--json"])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out.getvalue()), fake)

    def test_cli_platform_inventory_requires_json(self) -> None:
        code = cli(["platform", "inventory"])
        self.assertEqual(code, 2)
