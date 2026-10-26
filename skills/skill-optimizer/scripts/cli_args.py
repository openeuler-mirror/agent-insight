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

import os
from pathlib import Path
from typing import Optional


class CliArgsError(ValueError):
    pass


def resolve_human_feedback_content(mode: str, feedback_arg: Optional[str]) -> Optional[str]:
    if mode != "feedback":
        if feedback_arg:
            raise CliArgsError("--feedback is only allowed with --mode feedback")
        return None

    feedback_path_str = feedback_arg or os.getenv("HUMAN_FEEDBACK_FILE")
    if not feedback_path_str:
        raise CliArgsError("--feedback is required for --mode feedback")

    feedback_path = Path(feedback_path_str)
    if feedback_path.exists() and feedback_path.is_file():
        content = feedback_path.read_text(encoding="utf-8").strip()
    else:
        content = feedback_path_str.strip()

    if not content:
        raise CliArgsError("--feedback content is empty")

    return content


def resolve_trace_mode_args(
    skill_path: Optional[str],
    trajectories_path: Optional[str],
    mode: str,
) -> tuple[Optional[Path], Optional[Path]]:
    if mode != "trace":
        return None, None

    if not skill_path:
        raise CliArgsError("skill path is required for --mode trace")

    skill_dir = Path(skill_path)
    if not skill_dir.exists():
        raise CliArgsError(f"Skill directory not found: {skill_dir}")

    skill_md = skill_dir / "SKILL.md"
    if not skill_md.exists():
        raise CliArgsError(f"SKILL.md not found in: {skill_dir}")

    if not trajectories_path:
        raise CliArgsError("--trajectories is required for --mode trace")

    trajectories_dir = Path(trajectories_path)
    if not trajectories_dir.exists():
        raise CliArgsError(f"Trajectories directory not found: {trajectories_dir}")

    return skill_dir, trajectories_dir

