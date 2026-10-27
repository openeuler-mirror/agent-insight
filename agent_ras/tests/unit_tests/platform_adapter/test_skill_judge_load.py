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
