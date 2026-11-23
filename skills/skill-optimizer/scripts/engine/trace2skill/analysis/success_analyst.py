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

"""
Success Analyst (A+) for Trace2Skill Stage 2.

Based on arXiv:2603.25158v3 - Section B.2.2

Single-pass pattern extraction for successful trajectories.
Identifies generalizable behavior patterns that contributed to the correct answer.
"""

import concurrent.futures
import logging
import json
import uuid
from dataclasses import dataclass, field
from typing import Callable, Optional

from ..patch import SkillPatch, cleanup_json_fences, parse_edits_from_json
from ..trajectory import Trajectory, TrajectoryStatus

logger = logging.getLogger(__name__)


SUCCESS_ANALYST_SYSTEM_PROMPT = """You are an expert in success pattern analysis for AI agent systems.

Mission: Given a successful agent trajectory, identify generalizable behavior patterns that contributed to the correct answer.

Requirements:
- Broad Coverage — every effective behavior in the trajectory must be captured by a pattern.
- Frequency Awareness — patterns covering more instances should be listed first; rare behaviors should be absorbed into the nearest broader pattern.
- Generalization — each pattern must describe a general mechanism, not a single task-specific detail.

Follow Anthropic's recommendation for skill writing style: conciseness, actionability, and hierarchical disclosure."""


OUTPUT_FORMAT_PROMPT = """Output Format:
You MUST output your analysis in the following JSON format. Do not include any additional text outside of this JSON object:
{
    "reasoning": "string explaining your success pattern analysis",
    "edits": [
        {
        "operation": "insert|replace|delete",
        "target": "optional string to search for in the file",
        "target_start_line": optional integer start line (1-indexed),
        "target_end_line": optional integer end line (1-indexed, inclusive),
        "content": "optional string content to insert or replace with"
        }
    ],
    "success_memory_items": [
        {
            "title": "pattern title",
            "description": "pattern description"
        }
    ]
}
If no patch is needed, set "edits": [] and "success_memory_items": []."""


@dataclass
class SuccessAnalysisResult:
    patch: Optional[SkillPatch] = None
    success_memory_items: list[dict] = field(default_factory=list)
    reasoning: str = ""


class SuccessAnalyst:
    def __init__(self, llm_client: Callable[[str], str]):
        self.llm_client = llm_client

    def analyze(
        self,
        trajectory: Trajectory,
        skill_content: str,
    ) -> SuccessAnalysisResult:
        if trajectory.status != TrajectoryStatus.SUCCESS:
            logger.warning(
                f"Trajectory {trajectory.task_id} is not a success, skipping success analysis"
            )
            return SuccessAnalysisResult()

        logger.info(f"Analyzing success pattern for trajectory {trajectory.task_id}")

        trajectory_context = trajectory.format_for_analyst()

        prompt = "\n\n".join([
            "## System",
            SUCCESS_ANALYST_SYSTEM_PROMPT,
            "",
            "## Task Query",
            trajectory.query,
            "",
            "## Successful Execution Trace",
            trajectory_context,
            "",
            "## Current Skill (reference)",
            f"## Current Skill\n{skill_content}",
            "",
            OUTPUT_FORMAT_PROMPT
        ])

        response = self.llm_client(prompt)
        return self._create_analysis_result(response, trajectory)

    def _create_analysis_result(
        self,
        response_str: str,
        trajectory: Trajectory,
    ) -> SuccessAnalysisResult:
        cleaned = cleanup_json_fences(response_str)
        data = json.loads(cleaned)
        edits = parse_edits_from_json(data)

        success_memory_items = [
            {"title": item.get("title", ""), "description": item.get("description", "")}
            for item in data.get("success_memory_items", [])
        ]

        reasoning = data.get("reasoning", "")

        patch = None
        if edits:
            patch = SkillPatch(
                patch_id=str(uuid.uuid4())[:8],
                source_trajectory_id=trajectory.task_id,
                is_from_error=False,
                reasoning=reasoning,
                edits=edits,
            )

        return SuccessAnalysisResult(
            patch=patch,
            success_memory_items=success_memory_items,
            reasoning=reasoning,
        )


class BatchSuccessAnalyst:
    def __init__(
        self,
        llm_client: Callable[[str], str],
        max_concurrent: int = 16,
    ):
        self.analyst = SuccessAnalyst(llm_client)
        self.max_concurrent = max_concurrent

    def analyze_batch(
        self,
        trajectories: list[Trajectory],
        skill_content: str,
    ) -> list[SuccessAnalysisResult]:
        success_trajectories = [
            t for t in trajectories if t.status == TrajectoryStatus.SUCCESS
        ]

        logger.info(f"Analyzing {len(success_trajectories)} success trajectories")

        results = []
        with concurrent.futures.ThreadPoolExecutor(
            max_workers=self.max_concurrent
        ) as executor:
            futures = {
                executor.submit(
                    self.analyst.analyze,
                    t,
                    skill_content,
                ): t
                for t in success_trajectories
            }

            for future in concurrent.futures.as_completed(futures):
                trajectory = futures[future]
                try:
                    result = future.result()
                    results.append(result)
                except Exception as e:
                    logger.error(f"Error analyzing {trajectory.task_id}: {e}")
                    results.append(SuccessAnalysisResult())

        return results