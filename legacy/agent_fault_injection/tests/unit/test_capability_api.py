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

"""CI gate: fault.json may only reference L2 capability_api ops/methods."""

from __future__ import annotations

from pathlib import Path

from agent_fault_injection.fault_inject.catalog.capability_api import (
    allowed_ops,
    validate_skills_tree,
)
from agent_fault_injection.fault_inject.catalog.definition import default_skills_root


def test_capability_api_lists_known_ops() -> None:
    ops = allowed_ops()
    assert "file.write" in ops
    assert "tool_result.replace_text" in ops
    assert "system.append" in ops
    assert "messages.inject" in ops
    assert "assistant.replace_text" in ops


def test_all_bundled_fault_json_ops_are_in_capability_api() -> None:
    errors = validate_skills_tree(default_skills_root())
    assert errors == [], "\n".join(errors)


def test_unknown_op_is_rejected(tmp_path: Path) -> None:
    skill = tmp_path / "bogus"
    skill.mkdir()
    (skill / "fault.json").write_text(
        '{"name":"bogus","injection":{"runtime":[{"op":"tool_result.drop"}]}}',
        encoding="utf-8",
    )
    errors = validate_skills_tree(tmp_path)
    assert any("tool_result.drop" in item for item in errors)
