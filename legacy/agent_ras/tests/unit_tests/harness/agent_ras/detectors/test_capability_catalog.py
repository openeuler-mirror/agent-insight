# coding: utf-8
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
