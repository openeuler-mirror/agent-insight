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
Error Analyst (A-) for Trace2Skill Stage 2.

Based on arXiv:2603.25158v3 - Section B.2.1

Multi-turn ReAct-style agentic analysis for failure trajectories.
Each analyst takes a frozen copy of skill S0 and one trajectory, outputs a skill patch.
"""

import concurrent.futures
import logging
import uuid
import json
from dataclasses import dataclass
from typing import Callable, Optional

from ..patch import PatchEdit, SkillPatch, cleanup_json_fences, parse_edits_from_json
from ..trajectory import Trajectory, TrajectoryStatus

logger = logging.getLogger(__name__)


ERROR_ANALYST_SYSTEM_PROMPT = """You are an expert failure-analysis agent for AI agent systems.

Mission: Given an agent's execution artifacts (logs + produced files) and the ground-truth solution, diagnose why the agent failed, identify causal failure reasons, and validate your diagnosis by implementing a minimal fix that makes the agent output match the ground truth. Your analysis must be systematic, evidence-driven, and reproducible. Do not guess when you can verify.

Required Workflow (MANDATORY):
1. Understand the task and failure surface — identify exactly what is wrong in the output.
2. Trace the failure to agent behavior — locate the decision or code step that produced the mismatch.
3. Validate the root cause with a minimal fix — write fixed output and re-evaluate against the ground truth.
4. Re-evaluate — if still failing, return to steps 1–3 and revise your diagnosis.

Follow Anthropic's recommendation for skill writing style: conciseness, actionability, and hierarchical disclosure.
"""

OUTPUT_FORMAT_PROMPT = """Output Format:
You MUST output your analysis in the following JSON format. Do not include any additional text outside of this JSON object:
{
    "edits": [
        {
        "operation": "insert|replace|delete",
        "target": "optional string to search for in the file",
        "target_start_line": optional integer start line (1-indexed),
        "target_end_line": optional integer end line (1-indexed, inclusive),
        "content": "optional string content to insert or replace with",
        "reasoning": "string explaining why this patch addresses the failure",
        }
    ], 
    "root_cause_identified": "true if a root cause was identified, false otherwise",
    "root_cause": "trace failure root cause" 
}
If no patch is needed, set "patch": null.
"""


@dataclass
class ResponseModel:
    edits: list[PatchEdit]
    root_cause: str
    root_cause_identified: bool

    @staticmethod
    def from_json(json_str: str) -> "ResponseModel":
        cleaned = cleanup_json_fences(json_str)
        data = json.loads(cleaned)
        edits = parse_edits_from_json(data)

        root_cause_identified = data.get("root_cause_identified", "false")
        if isinstance(root_cause_identified, str):
            root_cause_identified = root_cause_identified.lower() == "true"

        return ResponseModel(
            edits=edits,
            root_cause=data.get("root_cause", ""),
            root_cause_identified=root_cause_identified,
        )


@dataclass
class AnalysisResult:
    patch: Optional[SkillPatch] = None
    reasoning: str = ""


class ErrorAnalyst:
    def __init__(
        self,
        llm_client: Callable[[str], str],
        max_turns: int = 3,
    ):
        self.llm_client = llm_client
        self.max_turns = max_turns

    def analyze(
        self,
        trajectory: Trajectory,
        skill_content: str,
    ) -> AnalysisResult:
        if trajectory.status != TrajectoryStatus.FAILURE:
            logger.warning(
                f"Trajectory {trajectory.task_id} is not a failure, skipping error analysis"
            )
            return AnalysisResult()

        trajectory_context = trajectory.format_for_analyst()
        current_observation = ""
        turn_count = 0

        logger.info(f"Starting error analysis for trajectory {trajectory.task_id}")

        while turn_count < self.max_turns:
            turn_count += 1

            logger.info(f"Trajectory: {trajectory.task_id}, Turn # {turn_count}")

            prompt_parts = [
                f"## System\n {ERROR_ANALYST_SYSTEM_PROMPT}\n",
                f"## Current Skill\n{skill_content}",
                f"## Task Query\n{trajectory.query}\n",
                f"## Agent Execution Trace\n{trajectory_context}",
                f"{OUTPUT_FORMAT_PROMPT}",
            ]

            if current_observation:
                prompt_parts.extend(
                    [
                        f"## Previous Analysis Attempt {turn_count - 1}\n",
                        current_observation,
                    ]
                )

            prompt_parts.extend(
                [
                    "## Instructions",
                    "Continue your analysis. If you have identified the root cause and can propose a valid fix, output your final patch. Otherwise, describe your next analysis steps.",
                ]
            )

            prompt = "\n\n".join(prompt_parts)
            response_str = self.llm_client(prompt)

            is_final = self._is_final_response(response_str)
            current_observation = response_str

            if is_final:
                logger.info(f"Error analysis completed in {turn_count} turns")
                return self._create_analysis_result(response_str, trajectory)

        logger.warning(
            f"Error analysis exhausted {turn_count} turns without resolution"
        )
        return self._create_analysis_result(current_observation, trajectory)

    def _is_final_response(self, response: str) -> bool:
        try:
            cleaned_response = cleanup_json_fences(response)
            response_dict = json.loads(cleaned_response)
            root_cause_identified = response_dict.get("root_cause_identified", "false")
            if isinstance(root_cause_identified, str):
                return root_cause_identified.lower() == "true"
            elif isinstance(root_cause_identified, bool):
                return root_cause_identified
            else:
                raise Exception("Invalid field type: root_cause_identified")
        except json.JSONDecodeError as e:
            logger.error(f"Invalid error analyzer response. Not a JSON format. Error: {str(e)} Response: {response}")
            return False
        except Exception as e:
            logger.error(f"Failed to parse error analyzer response. Error: {str(e)}")
            return False

    def _create_analysis_result(
        self,
        response_str: str,
        trajectory: Trajectory,
    ) -> AnalysisResult:
        patch = None
        response = ResponseModel.from_json(response_str)

        if response.edits:
            patch = SkillPatch(
                patch_id=str(uuid.uuid4())[:8],
                source_trajectory_id=trajectory.task_id,
                is_from_error=True,
                reasoning=response.root_cause,
                edits=response.edits,
            )

        return AnalysisResult(patch=patch, reasoning=response.root_cause)


class BatchErrorAnalyst:
    def __init__(
        self,
        llm_client: Callable[[str], str],
        max_concurrent: int = 8,
        max_turns: int = 3,
    ):
        self.analyst = ErrorAnalyst(llm_client, max_turns)
        self.max_concurrent = max_concurrent

    def analyze_batch(
        self,
        trajectories: list[Trajectory],
        skill_content: str,
    ) -> list[AnalysisResult]:
        failure_trajectories = [
            t for t in trajectories if t.status == TrajectoryStatus.FAILURE
        ]

        logger.info(f"Analyzing {len(failure_trajectories)} failure trajectories")

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
                for t in failure_trajectories
            }

            for future in concurrent.futures.as_completed(futures):
                trajectory = futures[future]
                try:
                    result = future.result()
                    results.append(result)
                except Exception as e:
                    logger.error(f"Error analyzing {trajectory.task_id}: {e}")
                    results.append(AnalysisResult())

        return results
