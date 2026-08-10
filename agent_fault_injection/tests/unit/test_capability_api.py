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
