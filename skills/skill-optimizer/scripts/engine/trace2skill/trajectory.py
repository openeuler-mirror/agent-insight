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
Trace data structures for Trace2Skill.
"""

import json
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Optional


class TrajectoryStatus(Enum):
    SUCCESS = "success"
    FAILURE = "failure"
    UNKNOWN = "unknown"


@dataclass
class TrajectoryStep:
    step_number: int
    reasoning: str
    tool_call: str
    observation: str

    @classmethod
    def from_dict(cls, data: dict) -> "TrajectoryStep":
        return cls(
            step_number=data["step_number"],
            reasoning=data["reasoning"],
            tool_call=data["tool_call"],
            observation=data["observation"],
        )


@dataclass
class Trajectory:
    task_id: str
    query: str
    steps: list[TrajectoryStep] = field(default_factory=list)
    final_output: str = ""
    status: TrajectoryStatus = TrajectoryStatus.UNKNOWN
    ground_truth: Optional[str] = None
    metadata: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: dict) -> "Trajectory":
        # Convert interactions to steps if steps not provided
        steps = data.get("steps", [])
        if isinstance(steps, list) and steps and isinstance(steps[0], dict) and "step_number" in steps[0]:
            steps = [TrajectoryStep.from_dict(s) for s in steps]
        elif not steps and "interactions" in data:
            steps = []
            for interaction in data["interactions"]:
                role = interaction.get("role", "")
                content = interaction.get("content", "")
                tool_calls = interaction.get("tool_calls") or []

                if role == "assistant" and tool_calls:
                    # Each tool call in this interaction becomes a step.
                    # The assistant's reasoning text is attached to the first
                    # tool call; subsequent calls share the same turn but get
                    # an empty reasoning field to avoid duplication.
                    for tc_idx, tc in enumerate(tool_calls):
                        func = tc.get("function", {})
                        tool_name = func.get("name", "")
                        tool_args = func.get("arguments", "")

                        tool_call_str = f"{tool_name}({tool_args})" if tool_name else str(tc)
                        observation = tc.get("output", "")

                        steps.append(TrajectoryStep(
                            step_number=len(steps) + 1,
                            reasoning=content if tc_idx == 0 else "",
                            tool_call=tool_call_str,
                            observation=observation,
                        ))
                elif role == "assistant" and not tool_calls:
                    # Pure assistant text without tool calls – either
                    # intermediate reasoning or the final answer.
                    steps.append(TrajectoryStep(
                        step_number=len(steps) + 1,
                        reasoning=content,
                        tool_call="",
                        observation="",
                    ))

        # --- query ---------------------------------------------------------
        query = data.get("query", "")
        if not query and "interactions" in data:
            for interaction in data["interactions"]:
                if interaction.get("role") == "user":
                    query = interaction.get("content", "")
                    break

        # --- final_output --------------------------------------------------
        final_output = data.get("final_output", "")
        if not final_output and "interactions" in data:
            for interaction in reversed(data["interactions"]):
                if interaction.get("role") == "assistant" and not interaction.get("tool_calls"):
                    final_output = interaction.get("content", "")
                    break

        # --- metadata ------------------------------------------------------
        metadata = data.get("metadata", {})
        for key in ("skillName", "skillId", "model", "user"):
            if key in data and key not in metadata:
                metadata[key] = data[key]

        return cls(
            task_id=data.get("taskId", data.get("task_id", "")),
            query=query,
            steps=steps,
            final_output=final_output,
            status=TrajectoryStatus(data.get("status", "unknown")),
            ground_truth=data.get("ground_truth"),
            metadata=metadata,
        )

    def is_success(self) -> bool:
        return self.status == TrajectoryStatus.SUCCESS

    def is_failure(self) -> bool:
        return self.status == TrajectoryStatus.FAILURE

    def format_for_analyst(self) -> str:
        lines = [
            f"## Task: {self.task_id}",
            f"### Query",
            self.query,
            f"### Execution Trace ({len(self.steps)} steps)",
        ]
        for step in self.steps:
            lines.extend([
                f"#### Step {step.step_number} ({step.tool_call})",
                f"**Reasoning:** {step.reasoning[:300] if step.reasoning else '(none)'}",
                f"**Observation:** {step.observation[:500] if step.observation else '(none)'}",
            ])
        lines.extend([
            f"### Final Output",
            self.final_output[:1000] if self.final_output else "(empty)",
        ])
        if self.metadata.get("framework"):
            lines.append(f"### Framework: {self.metadata['framework']}")
        if self.ground_truth:
            lines.extend([
                f"### Ground Truth",
                self.ground_truth,
            ])
        return "\n\n".join(lines)


@dataclass
class TrajectorySet:
    trajectories: list[Trajectory] = field(default_factory=list)
    source_skill: Optional[str] = None

    @property
    def success_count(self) -> int:
        return len([t for t in self.trajectories if t.is_success()])

    @property
    def failure_count(self) -> int:
        return len([t for t in self.trajectories if t.is_failure()])

    @property
    def total_count(self) -> int:
        return len(self.trajectories)

    @classmethod
    def load_from_directory(cls, trajectory_dir: Path) -> "TrajectorySet":
        trajectories = []
        for json_file in sorted(trajectory_dir.glob("*.json")):
            with open(json_file, encoding="utf-8") as f:
                data = json.load(f)
                trajectories.append(Trajectory.from_dict(data))

        return cls(trajectories=trajectories)