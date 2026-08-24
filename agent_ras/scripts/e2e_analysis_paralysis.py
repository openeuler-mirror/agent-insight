#!/usr/bin/env python3
# coding: utf-8
"""Synthetic E2E: analysis-paralysis FI unit → HostCallback Skill → abort.

Uses the fault-inject analysis-paralysis Skill (scenario 1). Thinking-loop L3
is disabled so the parked skill is analysis-paralysis-detection.

Usage:
  python scripts/e2e_analysis_paralysis.py
"""
from __future__ import annotations

import asyncio
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ROOT.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

DEFAULT_SKILL = (
    REPO_ROOT
    / "agent_fault_injection"
    / "fault_inject"
    / "skills"
    / "analysis-paralysis"
    / "SKILL.md"
)


def load_scenario1_unit(skill_path: Path) -> str:
    text = skill_path.read_text(encoding="utf-8")
    match = re.search(
        r"场景1：分析瘫痪长文注入.*?### 注入文本.*?```\n(.*?)```",
        text,
        re.S,
    )
    if not match:
        raise SystemExit(f"FAIL: cannot parse scenario1 unit from {skill_path}")
    unit = match.group(1).strip()
    if len(unit) < 400:
        raise SystemExit(f"FAIL: scenario1 unit too short ({len(unit)})")
    return unit


async def run() -> None:
    from ras_runtime.session_hub import SessionHub

    skill = Path(
        os.environ.get("ANALYSIS_PARALYSIS_SKILL") or DEFAULT_SKILL
    ).expanduser()
    if not skill.is_file():
        raise SystemExit(f"FAIL: skill not found: {skill}")

    unit = load_scenario1_unit(skill)
    print(f"[e2e-ap] skill={skill}")
    print(f"[e2e-ap] unit_chars={len(unit)}")

    hub = SessionHub()
    sid = "opencode:e2e_analysis_paralysis_s1"
    hub.hello(
        sid,
        "opencode",
        {
            "detectors": {
                "analysis_paralysis": {
                    "enabled": True,
                    "semantic_content_enabled": True,
                    "detection_start_chars": 50,
                },
                "llm_thinking_loop": {
                    "enabled": True,
                    "semantic_content_enabled": False,
                    "detection_start_chars": 999999,
                    "loop_repeat_threshold": 99,
                    "similar_clause_sim_threshold": 0.999,
                },
            },
        },
    )

    out = await hub.observe(
        sid,
        {
            "kind": "assistant_text",
            "channel": "llm_output",
            "mode": "snapshot",
            "text": unit,
            "platform": "opencode",
        },
    )
    reqs = out.get("skill_requests") or []
    if not reqs:
        raise SystemExit(
            f"FAIL: no skill_requests (actions={out.get('actions')!r} "
            f"anomaly={out.get('anomaly')!r})"
        )
    req = reqs[0]
    role = req.get("role")
    skill_name = req.get("skill_name")
    print(
        f"[e2e-ap] skill_request ok role={role} "
        f"skill={skill_name} id={req.get('request_id')}"
    )
    if role != "detection" or skill_name != "analysis-paralysis-detection":
        raise SystemExit(
            f"FAIL: unexpected skill_request role/skill "
            f"role={role!r} skill={skill_name!r}"
        )

    result = await hub.skill_result(
        sid,
        {
            "request_id": req["request_id"],
            "result": {
                "abnormal": True,
                "primary_fault": "analysis_paralysis",
                "confidence": 0.9,
                "rationale": "e2e analysis-paralysis scenario1 (mock judge)",
            },
        },
    )
    if not result.get("ok"):
        raise SystemExit(f"FAIL: skill_result not ok: {result!r}")
    types = [a.get("type") for a in (result.get("actions") or [])]
    anomaly = result.get("anomaly") or {}
    evidence = anomaly.get("evidence") or {}
    print(
        f"[e2e-ap] actions={types} kind={anomaly.get('kind')} "
        f"channel={evidence.get('channel')}"
    )
    if anomaly.get("kind") != "analysis_paralysis":
        raise SystemExit(f"FAIL: expected kind analysis_paralysis, got {anomaly!r}")
    if "abort_stream" not in types:
        raise SystemExit(f"FAIL: expected abort_stream, got {types}")
    if "emit_notice" not in types and "push_steering" not in types:
        raise SystemExit(f"FAIL: expected notice/steer, got {types}")

    # Contrast: literal cycle without trigger words must not gate AP.
    hub2 = SessionHub()
    sid2 = "opencode:e2e_analysis_paralysis_contrast"
    hub2.hello(
        sid2,
        "opencode",
        {
            "detectors": {
                "analysis_paralysis": {
                    "enabled": True,
                    "semantic_content_enabled": True,
                    "detection_start_chars": 1,
                },
                "llm_thinking_loop": {
                    "enabled": True,
                    "semantic_content_enabled": False,
                    "detection_start_chars": 999999,
                    "loop_repeat_threshold": 99,
                },
            },
        },
    )
    cycle = ("abcdefghij" * 20) + "\n\n" + ("abcdefghij" * 20) + "\n\n"
    contrast = await hub2.observe(
        sid2,
        {
            "kind": "assistant_text",
            "channel": "llm_output",
            "mode": "snapshot",
            "text": cycle,
            "platform": "opencode",
        },
    )
    contrast_skills = [
        r.get("skill_name")
        for r in (contrast.get("skill_requests") or [])
    ]
    if "analysis-paralysis-detection" in contrast_skills:
        raise SystemExit(
            f"FAIL: dead-loop-like cycle should not gate AP (no trigger words), got {contrast_skills}"
        )
    print("[e2e-ap] contrast ok (no AP skill on literal cycle)")
    print("E2E_ANALYSIS_PARALYSIS_OK")


if __name__ == "__main__":
    asyncio.run(run())
