# coding: utf-8
"""Unit tests for detectors.catalog.build_capability_catalog."""
from __future__ import annotations

from detectors.catalog import build_capability_catalog
from detectors.loader import detector_plugins, ensure_domains_loaded, reset_domains_for_tests


def test_capability_catalog_matches_plugins() -> None:
    reset_domains_for_tests()
    ensure_domains_loaded(force=True)
    catalog = build_capability_catalog()
    plugins = detector_plugins()

    assert catalog["version"] == 1
    domain_ids = [d["id"] for d in catalog["domains"]]
    assert set(domain_ids) == set(plugins)
    orders = [
        (plugin.presentation.order if plugin.presentation else 100, plugin.id)
        for plugin in plugins.values()
    ]
    expected = [pid for _order, pid in sorted(orders)]
    assert domain_ids == expected

    by_id = {d["id"]: d for d in catalog["domains"]}
    for domain_id, plugin in plugins.items():
        schema = by_id[domain_id]["configSchema"]
        assert isinstance(schema, dict)
        assert "properties" in schema
        assert isinstance(schema["properties"], dict)
        assert schema["properties"]
        assert isinstance(by_id[domain_id]["configDefaults"], dict)
        presented = {sm["id"] for sm in by_id[domain_id]["submodes"]}
        if plugin.presentation is not None:
            expected_sub = {sm.id for sm in plugin.presentation.submodes}
            assert presented == expected_sub
