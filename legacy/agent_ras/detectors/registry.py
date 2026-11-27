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

"""Shared detector registry for Monitor (deep) and SessionHub (protocol).

Domain plugins are discovered by ``detectors.loader``; this module keeps the
public factory surface and wire-compat constants.
"""
from __future__ import annotations

from detectors.loader import (
    build_member_detectors,
    detector_config_models,
)
from detectors.skill_verdicts import SkillVerdict, parse_skill_verdict


def parse_recovery_verdict(skill_name: str, result: dict) -> SkillVerdict:
    """Parse an L3 review-skill verdict; registry seam so Monitor stays off detector internals."""
    return parse_skill_verdict(skill_name, result)


__all__ = [
    "build_member_detectors",
    "detector_config_models",
    "parse_recovery_verdict",
]
