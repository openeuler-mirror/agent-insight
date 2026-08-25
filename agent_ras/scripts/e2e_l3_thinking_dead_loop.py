#!/usr/bin/env python3
# coding: utf-8
"""Synthetic E2E: thinking_dead_loop 场景2 → HostCallback L3 → recovery actions.

Uses the fault-inject skill's 逻辑死循环 UNIT (scenario 2). L2 thresholds are
raised so only the semantic (L3) path fires — mirrors production wiring with a
deterministic mock judge (no nested OpenCode session).

Usage:
  python scripts/e2e_l3_thinking_dead_loop.py
  THINKING_DEAD_LOOP_SKILL=/path/to/SKILL.md python scripts/e2e_l3_thinking_dead_loop.py

Default skill (when env unset):
  <repo>/agent_fault_injection/fault_inject/skills/thinking-dead-loop/SKILL.md
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
    / "thinking-dead-loop"
    / "SKILL.md"
)


def load_scenario2_unit(skill_path: Path) -> str:
    text = skill_path.read_text(encoding="utf-8")
    m = re.search(
        r"场景2：逻辑死循环.*?### 注入文本.*?```\n(.*?)```",
        text,
        re.S,
    )
    if not m:
        raise SystemExit(f"FAIL: cannot parse scenario2 unit from {skill_path}")
    unit = m.group(1).strip()
    if len(unit) < 200:
        raise SystemExit(f"FAIL: scenario2 unit too short ({len(unit)})")
    return unit


async def run() -> None:
    from ras_runtime.session_hub import SessionHub

    skill = Path(
        os.environ.get("THINKING_DEAD_LOOP_SKILL") or DEFAULT_SKILL
    ).expanduser()
    if not skill.is_file():
        raise SystemExit(f"FAIL: skill not found: {skill}")

    unit = load_scenario2_unit(skill)
    # One UNIT is enough for L3 gate; repeat a few times like the skill asks.
    reps = int(os.environ.get("SMOKE_REPS", "3"))
    text = ("\n".join([unit] * reps)).strip()
    print(f"[e2e-l3] skill={skill}")
    print(f"[e2e-l3] unit_chars={len(unit)} reps={reps} total={len(text)}")

    hub = SessionHub()
    sid = "opencode:e2e_thinking_dead_loop_s2"
    hub.hello(
        sid,
        "opencode",
        {
            # Allow L3 early; keep L2 from stealing the hit on similar clauses.
            "llm_thinking_loop": {
                "detection_start_chars": 200,
                "window_max_chars": 2000,
                "loop_repeat_threshold": 99,
                "similar_clause_sim_threshold": 0.999,
                "semantic_eval_chars": 200,
                "semantic_content_enabled": True,
            },
        },
    )

    out = await hub.observe(
        sid,
        {
            "kind": "assistant_text",
            "channel": "llm_output",
            "mode": "snapshot",
            "text": text,
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
        f"[e2e-l3] skill_request ok role={role} "
        f"skill={skill_name} id={req.get('request_id')}"
    )
    if role != "detection" or skill_name != "llm-loop-detection":
        raise SystemExit(
            f"FAIL: unexpected skill_request role/skill "
            f"role={role!r} skill={skill_name!r}"
        )
    from agents.base import ROLE_SKILL_DIRS, load_skill_body

    review_body = load_skill_body("review", "llm-loop-review")
    if not review_body or "review" not in ROLE_SKILL_DIRS:
        raise SystemExit("FAIL: review skill path / body missing after P2")
    print(
        f"[e2e-l3] review_skill_ok chars={len(review_body)} "
        f"dir={ROLE_SKILL_DIRS['review']}"
    )
    payload_preview = str(req.get("payload") or "")[:60].replace("\n", " ")
    print(f"[e2e-l3] payload_preview={payload_preview!r}...")

    result = await hub.skill_result(
        sid,
        {
            "request_id": req["request_id"],
            "result": {
                "abnormal": True,
                "primary_fault": "semantic_deadlock",
                "confidence": 0.92,
                "rationale": "e2e thinking_dead_loop scenario2 (mock judge)",
            },
        },
    )
    if not result.get("ok"):
        raise SystemExit(f"FAIL: skill_result not ok: {result!r}")
    types = [a.get("type") for a in (result.get("actions") or [])]
    anomaly = result.get("anomaly") or {}
    evidence = anomaly.get("evidence") or {}
    print(f"[e2e-l3] actions={types} channel={evidence.get('channel')}")
    if "abort_stream" not in types:
        raise SystemExit(f"FAIL: expected abort_stream, got {types}")
    if "emit_notice" not in types and "push_steering" not in types:
        raise SystemExit(f"FAIL: expected notice/steer, got {types}")

    print("E2E_L3_THINKING_DEAD_LOOP_OK")


if __name__ == "__main__":
    asyncio.run(run())
