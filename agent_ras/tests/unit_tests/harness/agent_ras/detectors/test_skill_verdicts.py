# coding: utf-8
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
