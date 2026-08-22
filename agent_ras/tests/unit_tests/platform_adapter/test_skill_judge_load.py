# coding: utf-8
"""OpenCode loadSkillBody resolves SKILL.md by skill_name, not a hardcoded path."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

_SKILL_JUDGE = (
    Path(__file__).resolve().parents[3]
    / "platform_adapter"
    / "opencode"
    / "skill_judge.js"
)


def test_load_skill_body_resolves_by_name() -> None:
    href_expr = (
        "pathToFileURL(" + json.dumps(str(_SKILL_JUDGE)) + ").href"
    )
    script = f"""
import {{ pathToFileURL }} from 'node:url';
const mod = await import({href_expr});
const det = mod.loadSkillBody('detection', 'llm-loop-detection');
const review = mod.loadSkillBody('review', 'llm-loop-review');
const missing = mod.loadSkillBody('detection', 'does-not-exist-skill-xyz');
console.log(JSON.stringify({{
  detOk: det.includes('llm-loop-detection'),
  reviewOk: review.includes('llm-loop-review'),
  missingIsError: missing.includes('未能从本地包路径加载'),
  missingOwnName: missing.includes('does-not-exist-skill-xyz'),
  missingNotLoopPath: !missing.includes('llm-loop-detection'),
}}));
"""
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        check=False,
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0, proc.stderr
    payload = json.loads(proc.stdout.strip().splitlines()[-1])
    assert payload == {
        "detOk": True,
        "reviewOk": True,
        "missingIsError": True,
        "missingOwnName": True,
        "missingNotLoopPath": True,
    }
