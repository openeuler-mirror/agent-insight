# coding: utf-8
"""Review plugin for llm_thinking_loop (L3 semantic judge)."""
from __future__ import annotations

from typing import Any

from detectors.skill_verdicts import (
    SkillVerdict,
    extract_report_payload,
    fail_open_verdict,
)
from detectors.types import ReviewPlugin

# Aligned with review/skills/llm-loop-review/SKILL.md (not shared with detection).
_REVIEW_PRIMARY_FAULTS = frozenset(
    {
        "none",
        "semantic_deadlock",
        "text_degradation",
    }
)


def parse_review_verdict(raw: str | dict[str, Any]) -> SkillVerdict:
    """Thin parse for llm-loop-review; primary_fault stays in raw for recovery."""
    payload = extract_report_payload(raw)
    if payload is None:
        return fail_open_verdict("unparseable_payload")
    if not {"abnormal", "primary_fault"}.issubset(payload.keys()):
        return fail_open_verdict("missing_required_fields")

    fault = str(payload.get("primary_fault") or "").strip().lower()
    if fault not in _REVIEW_PRIMARY_FAULTS:
        return fail_open_verdict("schema_validation_failed")

    try:
        abnormal = bool(payload.get("abnormal"))
        confidence = float(payload.get("confidence") or 0.0)
        rationale = str(payload.get("rationale") or "")
    except (ValueError, TypeError):
        return fail_open_verdict("schema_validation_failed")

    fault_abnormal = fault != "none"
    if abnormal != fault_abnormal:
        return fail_open_verdict("abnormal_primary_fault_inconsistent")

    return SkillVerdict(
        abnormal=abnormal,
        confidence=confidence,
        rationale=rationale,
        raw=dict(payload),
    )


REVIEW_PLUGIN = ReviewPlugin(
    id="llm_thinking_loop",
    review_skill="llm-loop-review",
    verdict_parser=parse_review_verdict,
)

__all__ = ["REVIEW_PLUGIN", "parse_review_verdict"]
