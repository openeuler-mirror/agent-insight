"""Unit tests for OpenCode CLI agent/model catalog parsing."""

from __future__ import annotations

from unittest import TestCase

from agent_fault_injection.platform_adapters.opencode.catalog import (
    agent_matches_oh_my_key,
    choose_default_agent,
    filter_models_by_providers,
    list_opencode_agents,
    list_opencode_models,
    load_oh_my_agent_keys,
    models_from_config_providers,
    parse_opencode_agent_list_output,
    parse_opencode_models_output,
    select_usable_agents,
)


_AGENT_CLI = """
[AET] Trace logging installed
build (subagent)
  [
  {
    "permission": "*"
  }
  ]
plan (subagent)
compaction (primary)
summary (primary)
title (primary)
ras-judge (subagent)
explore (subagent)
general (subagent)
aet-implement (primary)
\u200bSisyphus - Ultraworker (primary)
oracle (subagent)
librarian (subagent)
\u200b\u200b\u200bPrometheus - Plan Builder (primary)
Atlas - Plan Executor (primary)
deepresearch (primary)
"""

_MODELS_CLI = """
[AET] Trace logging installed
opencode/big-pickle
google/gemini-2.5-flash
google/antigravity-gemini-3-pro
huawei-blue/GLM-5.2
personal/Minimax-M3
deepseek/deepseek-chat
deepseek/deepseek-reasoner
minimax/MiniMax-M2
"""


class OpenCodeCatalogParseTests(TestCase):
    def test_parse_agents_excludes_system_agents(self) -> None:
        agents = parse_opencode_agent_list_output(_AGENT_CLI)
        ids = [item["id"] for item in agents]
        self.assertIn("build", ids)
        self.assertIn("plan", ids)
        self.assertIn("explore", ids)
        self.assertIn("aet-implement", ids)
        self.assertIn("Sisyphus - Ultraworker", ids)
        self.assertIn("oracle", ids)
        self.assertNotIn("compaction", ids)
        self.assertNotIn("summary", ids)
        self.assertNotIn("title", ids)
        self.assertNotIn("ras-judge", ids)
        build = next(item for item in agents if item["id"] == "build")
        self.assertEqual(build["mode"], "subagent")

    def test_choose_default_prefers_build(self) -> None:
        agents = parse_opencode_agent_list_output(_AGENT_CLI)
        self.assertEqual(choose_default_agent(agents), "build")
        self.assertEqual(
            choose_default_agent([{"id": "plan"}, {"id": "explore"}]),
            "plan",
        )

    def test_oh_my_key_matching(self) -> None:
        self.assertTrue(agent_matches_oh_my_key("Sisyphus - Ultraworker", "sisyphus"))
        self.assertTrue(agent_matches_oh_my_key("oracle", "oracle"))
        self.assertTrue(agent_matches_oh_my_key("Sisyphus-Junior", "sisyphus-junior"))
        self.assertFalse(agent_matches_oh_my_key("aet-implement", "sisyphus"))

    def test_select_usable_agents_includes_oh_my(self) -> None:
        cli_agents = parse_opencode_agent_list_output(_AGENT_CLI)
        selected = select_usable_agents(
            cli_agents,
            config={
                "agent": {
                    "ras-judge": {"hidden": True, "mode": "subagent"},
                    "my-custom": {"mode": "primary"},
                }
            },
            oh_my_keys={
                "sisyphus",
                "oracle",
                "librarian",
                "prometheus",
                "atlas",
                "explore",
            },
        )
        ids = [item["id"] for item in selected]
        # Prefer known builtins that appear in CLI, in _BUILTIN_AGENTS order.
        self.assertEqual(ids[:4], ["build", "plan", "general", "explore"])
        self.assertIn("my-custom", ids)
        self.assertIn("Sisyphus - Ultraworker", ids)
        self.assertIn("oracle", ids)
        self.assertIn("Prometheus - Plan Builder", ids)
        self.assertIn("Atlas - Plan Executor", ids)
        self.assertNotIn("aet-implement", ids)
        self.assertNotIn("deepresearch", ids)
        self.assertNotIn("ras-judge", ids)

    def test_select_usable_agents_does_not_synthesize_missing_builtins(self) -> None:
        selected = select_usable_agents(
            [],
            config={"agent": {"my-custom": {"mode": "primary"}}},
            oh_my_keys={"sisyphus", "oracle"},
        )
        ids = [item["id"] for item in selected]
        self.assertEqual(ids, ["my-custom"])
        for builtin in ("build", "plan", "general", "explore"):
            self.assertNotIn(builtin, ids)

    def test_select_usable_agents_omits_builtins_absent_from_cli(self) -> None:
        selected = select_usable_agents(
            [{"id": "explore", "name": "explore", "mode": "subagent"}],
            config={},
            oh_my_keys=set(),
        )
        ids = [item["id"] for item in selected]
        self.assertEqual(ids, ["explore"])
        self.assertNotIn("build", ids)
        self.assertNotIn("plan", ids)
        self.assertNotIn("general", ids)

    def test_list_agents_from_cli_with_oh_my_config(self) -> None:
        result = list_opencode_agents(
            cli_output=_AGENT_CLI,
            config={},
            oh_my_config={
                "agents": {
                    "sisyphus": {"model": "personal/Minimax-M3"},
                    "oracle": {},
                }
            },
        )
        self.assertEqual(result["platform"], "opencode")
        self.assertEqual(result["default"], "build")
        ids = [item["id"] for item in result["agents"]]
        self.assertIn("build", ids)
        self.assertIn("Sisyphus - Ultraworker", ids)
        self.assertIn("oracle", ids)
        self.assertNotIn("aet-implement", ids)
        self.assertNotIn("ras-judge", ids)

    def test_load_oh_my_agent_keys_from_dict(self) -> None:
        keys = load_oh_my_agent_keys(
            oh_my_config={"agents": {"sisyphus": {}, "oracle": {}}}
        )
        self.assertEqual(keys, {"sisyphus", "oracle"})

    def test_parse_models_lines(self) -> None:
        models = parse_opencode_models_output(_MODELS_CLI)
        ids = [item["id"] for item in models]
        self.assertIn("huawei-blue/GLM-5.2", ids)
        self.assertIn("deepseek/deepseek-chat", ids)

    def test_filter_models_by_configured_providers(self) -> None:
        models = parse_opencode_models_output(_MODELS_CLI)
        filtered = filter_models_by_providers(
            models,
            {"huawei-blue", "personal"},
        )
        self.assertEqual(
            [item["id"] for item in filtered],
            ["huawei-blue/GLM-5.2", "personal/Minimax-M3"],
        )

    def test_list_models_unions_usable_config_and_credentialed_cli(self) -> None:
        result = list_opencode_models(
            cli_output=_MODELS_CLI,
            config={
                "model": "huawei-blue/GLM-5.2",
                "provider": {
                    "huawei-blue": {
                        "options": {"apiKey": "sk-test"},
                        "models": {"GLM-5.2": {"name": "GLM 5.2"}},
                    },
                    "personal": {
                        "options": {"apiKey": "sk-test"},
                        "models": {
                            "Minimax-M3": {"name": "Minimax M3"},
                            "Minimax-M2.7-highspeed": {},
                        },
                    },
                    "google": {
                        "models": {
                            "antigravity-gemini-3-pro": {
                                "name": "Gemini 3 Pro (Antigravity)",
                            }
                        },
                    },
                },
            },
            auth_providers={"deepseek"},
            environ={},
            providers_list_output="",
        )
        ids = [item["id"] for item in result["models"]]
        self.assertEqual(result["default"], "huawei-blue/GLM-5.2")
        self.assertTrue(result["models"][0]["default"])
        self.assertIn("huawei-blue/GLM-5.2", ids)
        self.assertIn("personal/Minimax-M3", ids)
        self.assertIn("personal/Minimax-M2.7-highspeed", ids)
        self.assertIn("deepseek/deepseek-chat", ids)
        self.assertIn("deepseek/deepseek-reasoner", ids)
        # No Google credentials and no inline apiKey → excluded.
        self.assertNotIn("google/antigravity-gemini-3-pro", ids)
        self.assertNotIn("google/gemini-2.5-flash", ids)

    def test_list_models_fallback_filters_credentialed_only(self) -> None:
        result = list_opencode_models(
            cli_output=_MODELS_CLI,
            config={"provider": {}},
            auth_providers={"deepseek"},
            environ={},
            providers_list_output="",
        )
        ids = [item["id"] for item in result["models"]]
        self.assertEqual(
            set(ids),
            {"deepseek/deepseek-chat", "deepseek/deepseek-reasoner"},
        )
        self.assertNotIn("huawei-blue/GLM-5.2", ids)

    def test_models_from_config_providers_require_usable(self) -> None:
        config = {
            "provider": {
                "huawei-blue": {
                    "options": {"apiKey": "sk-test"},
                    "models": {"GLM-5.2": {"name": "GLM 5.2"}},
                },
                "google": {
                    "models": {"antigravity-gemini-3-pro": {"name": "Gemini"}},
                },
            }
        }
        all_models = models_from_config_providers(config)
        self.assertEqual(
            {item["id"] for item in all_models},
            {"huawei-blue/GLM-5.2", "google/antigravity-gemini-3-pro"},
        )
        usable = models_from_config_providers(
            config,
            credentialed=set(),
            require_usable=True,
        )
        self.assertEqual([item["id"] for item in usable], ["huawei-blue/GLM-5.2"])
