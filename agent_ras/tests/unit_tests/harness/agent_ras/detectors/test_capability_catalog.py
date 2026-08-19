# coding: utf-8
"""Unit tests for detectors.catalog.build_capability_catalog."""
from __future__ import annotations

from detectors.catalog import build_capability_catalog
from detectors.loader import ensure_domains_loaded, reset_domains_for_tests


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

    by_id = {d["id"]: d for d in catalog["domains"]}
    for domain_id in ("llm_thinking_loop", "repeat_tool"):
        schema = by_id[domain_id]["configSchema"]
        assert isinstance(schema, dict)
        assert "properties" in schema
        assert isinstance(schema["properties"], dict)
        assert schema["properties"]
        assert isinstance(by_id[domain_id]["configDefaults"], dict)
