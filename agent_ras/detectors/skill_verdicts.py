# coding: utf-8
# Copyright (c) Huawei Technologies Co., Ltd. 2026. All rights reserved.
"""Structured skill output schemas and generic parsers (detector layer)."""
from __future__ import annotations

import json
import re
from typing import Any, Callable

from pydantic import BaseModel, Field

VerdictParser = Callable[[str | dict[str, Any]], "SkillVerdict"]

_PARSERS: dict[str, VerdictParser] = {}


class SkillVerdict(BaseModel):
    """Base structured skill result."""

    abnormal: bool = False
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    rationale: str = ""
    raw: dict[str, Any] = Field(default_factory=dict)
    # Non-empty when parser rejected input and returned fail-open normal.
    fail_open_reason: str = ""


def register_skill_parser(skill_name: str, parser: VerdictParser) -> None:
    name = str(skill_name or "").strip()
    if not name:
        return
    _PARSERS[name] = parser


def clear_skill_parsers() -> None:
    _PARSERS.clear()


def extract_json_object_from_text(raw: str) -> dict[str, Any] | None:
    """Parse a JSON object from agent output (bare JSON or ```json fence)."""
    text = str(raw or "").strip()
    if not text:
        return None
    match = re.search(r"```json\s*(.*?)\s*```", text, re.DOTALL)
    if match:
        json_str = match.group(1)
    elif text.startswith("{") and text.endswith("}"):
        json_str = text
    else:
        obj_match = re.search(r"\{.*\}", text, re.DOTALL)
        if not obj_match:
            return None
        json_str = obj_match.group(0)
    try:
        parsed = json.loads(json_str)
    except (json.JSONDecodeError, TypeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def extract_invoke_output_payload(result: Any) -> dict[str, Any] | None:
    """Extract structured JSON from a DeepAgent invoke result (auto_harness style)."""
    if isinstance(result, dict):
        output = result.get("output")
        if isinstance(output, str) and output.strip():
            return extract_json_object_from_text(output)
        return extract_report_payload(result)
    if isinstance(result, str):
        return extract_json_object_from_text(result) or extract_report_payload(result)
    return None


def extract_report_payload(raw: str | dict[str, Any]) -> dict[str, Any] | None:
    """Extract a JSON object from skill_complete report or top-level payload."""
    if isinstance(raw, dict):
        data: dict[str, Any] = raw
        for key in ("report", "response", "text", "content"):
            val = data.get(key)
            if isinstance(val, dict):
                return val
            if isinstance(val, str) and val.strip():
                try:
                    parsed = json.loads(val.strip())
                    if isinstance(parsed, dict):
                        return parsed
                except (json.JSONDecodeError, TypeError):
                    continue
        return data if data else None

    text = str(raw or "").strip()
    if not text:
        return None
    fenced = extract_json_object_from_text(text)
    if fenced is not None:
        return fenced
    try:
        parsed = json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def fail_open_verdict(reason: str = "invalid_or_empty") -> SkillVerdict:
    return SkillVerdict(
        abnormal=False,
        confidence=0.0,
        rationale="",
        raw={},
        fail_open_reason=reason,
    )


def parse_generic_verdict(raw: str | dict[str, Any]) -> SkillVerdict:
    """Parse {abnormal, confidence, rationale}; extra fields stay in raw."""
    payload = extract_report_payload(raw)
    if payload is None:
        return fail_open_verdict("unparseable_payload")
    if "abnormal" not in payload:
        return fail_open_verdict("missing_required_fields")
    try:
        return SkillVerdict(
            abnormal=bool(payload.get("abnormal")),
            confidence=float(payload.get("confidence") or 0.0),
            rationale=str(payload.get("rationale") or ""),
            raw=dict(payload),
        )
    except (ValueError, TypeError):
        return fail_open_verdict("schema_validation_failed")


def parse_skill_verdict(skill_name: str, raw: str | dict[str, Any]) -> SkillVerdict:
    if not _PARSERS:
        try:
            from detectors.loader import ensure_domains_loaded

            ensure_domains_loaded()
        except Exception:
            pass
    parser = _PARSERS.get(str(skill_name or "").strip()) or parse_generic_verdict
    return parser(raw)


def verdict_to_dict(verdict: SkillVerdict) -> dict[str, Any]:
    """Serialize a verdict for adapter/detector consumption."""
    data: dict[str, Any] = {
        "abnormal": verdict.abnormal,
        "confidence": verdict.confidence,
        "rationale": verdict.rationale,
    }
    if verdict.fail_open_reason:
        data["fail_open_reason"] = verdict.fail_open_reason
    if verdict.raw:
        data.update({k: v for k, v in verdict.raw.items() if k not in data})
    return data
