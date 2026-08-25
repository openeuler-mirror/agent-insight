# coding: utf-8
# Copyright (c) Huawei Technologies Co., Ltd. 2026. All rights reserved.
"""Unit tests for fault-domain skill registry."""
from __future__ import annotations

import pytest

from agents.base import (
    FAULT_DOMAIN_SKILLS,
    fault_domain_for_kind,
    skill_for,
)
from detectors.loader import detector_plugins, ensure_domains_loaded, reset_domains_for_tests


def test_plugin_skill_registry_join() -> None:
    reset_domains_for_tests()
    ensure_domains_loaded(force=True)
    plugins = detector_plugins()
    assert plugins
    for plugin in plugins.values():
        for kind in plugin.kinds:
            mapped = fault_domain_for_kind(kind)
            assert mapped == plugin.kind_to_domain.get(kind, plugin.id)
        if plugin.detection_skill:
            assert skill_for(plugin.id, "detection") == plugin.detection_skill
    assert fault_domain_for_kind("unknown") is None


def test_skill_for_unknown_raises() -> None:
    reset_domains_for_tests()
    ensure_domains_loaded(force=True)
    with pytest.raises(ValueError, match="unknown fault domain"):
        skill_for("no_such_domain", "detection")
    domain = next(iter(FAULT_DOMAIN_SKILLS))
    with pytest.raises(ValueError, match="unknown role"):
        skill_for(domain, "reviewer")
