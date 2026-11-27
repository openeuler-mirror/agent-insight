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

"""Plugin-owned terminate_kinds (no framework domain names)."""
from __future__ import annotations

from detectors.loader import (
    ensure_domains_loaded,
    recovery_terminate_kinds,
    reset_domains_for_tests,
)


def test_builtin_repeat_tool_terminate_kinds() -> None:
    reset_domains_for_tests()
    ensure_domains_loaded(force=True)
    kinds = recovery_terminate_kinds()
    assert "repeat_tool_call" in kinds
    assert "tool_call_loop" in kinds
    assert "llm_thinking_loop" not in kinds
