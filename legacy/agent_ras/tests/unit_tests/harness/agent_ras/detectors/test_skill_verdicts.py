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

"""Generic skill verdict parsing (unregistered skill_name)."""
from __future__ import annotations

from detectors.skill_verdicts import (
    parse_generic_verdict,
    parse_skill_verdict,
    verdict_to_dict,
)


def test_unregistered_skill_uses_generic_parser() -> None:
    verdict = parse_skill_verdict(
        "third-domain-skill",
        '{"abnormal": true, "confidence": 0.8, "rationale": "loop", "extra": 1}',
    )
    assert verdict.fail_open_reason == ""
    assert verdict.abnormal is True
    assert verdict.confidence == 0.8
    assert verdict.rationale == "loop"
    data = verdict_to_dict(verdict)
    assert data["abnormal"] is True
    assert data["extra"] == 1


def test_generic_parser_missing_abnormal_fail_open() -> None:
    verdict = parse_generic_verdict('{"confidence": 0.5}')
    assert verdict.abnormal is False
    assert verdict.fail_open_reason == "missing_required_fields"
