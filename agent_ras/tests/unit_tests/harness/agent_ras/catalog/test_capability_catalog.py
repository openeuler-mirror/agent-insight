# coding: utf-8
"""Unit tests for catalog.build_capability_catalog."""
from __future__ import annotations

from catalog.build import build_capability_catalog
from detectors.loader import ensure_domains_loaded, reset_domains_for_tests


_EXPECTED_SUBMODE_IDS = [
    "generic_repeat",
    "unknown_tool_repeat",
    "ping_pong",
    "global_circuit_breaker",
    "suffix_cycle",
    "similar_clauses",
    "plan_execution",
]


def test_capability_catalog_builtin_domains_and_submodes() -> None:
    reset_domains_for_tests()
    ensure_domains_loaded(force=True)
    catalog = build_capability_catalog()

    assert catalog["version"] == 1
    domain_ids = [d["id"] for d in catalog["domains"]]
    assert "llm_thinking_loop" in domain_ids
    assert "repeat_tool" in domain_ids
    # presentation.order: repeat_tool=10 before llm_thinking_loop=20
    assert domain_ids.index("repeat_tool") < domain_ids.index("llm_thinking_loop")

    flat_ids = [s["id"] for s in catalog["submodes"]]
    assert len(flat_ids) == 7
    assert flat_ids == _EXPECTED_SUBMODE_IDS
    assert {s["domainId"] for s in catalog["submodes"]} == {
        "llm_thinking_loop",
        "repeat_tool",
    }

    by_id = {d["id"]: d for d in catalog["domains"]}
    for domain_id in ("llm_thinking_loop", "repeat_tool"):
        schema = by_id[domain_id]["configSchema"]
        assert isinstance(schema, dict)
        assert "properties" in schema
        assert isinstance(schema["properties"], dict)
        assert schema["properties"]
        assert isinstance(by_id[domain_id]["configDefaults"], dict)

    assert by_id["llm_thinking_loop"]["review_skill"] == "llm-loop-review"
    assert "llm_thinking_loop" in by_id["llm_thinking_loop"]["stream_kinds"]
    assert catalog["recovery"]["global"]["notify_user_on_warning"] is True

    plan = next(s for s in catalog["submodes"] if s["id"] == "plan_execution")
    assert plan["runtimeKeys"]["mode"] == "plan_execution_loop_lock"
    assert plan["primaryFaults"] == [
        "semantic_deadlock",
        "text_degradation",
        "overthinking",
    ]
    assert plan["prompts"][0]["templateZh"]
    assert plan["prompts"][0]["templateEn"]
