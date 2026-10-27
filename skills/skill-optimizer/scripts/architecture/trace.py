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

from dataclasses import dataclass, field
from typing import List, Dict, Any, Optional
from enum import Enum

class StepType(Enum):
    THOUGHT = "thought"
    ACTION = "action"
    OBSERVATION = "observation"
    FINAL_ANSWER = "final_answer"
    ERROR = "error"

@dataclass
class Step:
    """A single step in the agent's execution trace."""
    type: StepType
    content: str
    tool_name: Optional[str] = None
    tool_args: Optional[Dict[str, Any]] = None
    duration_ms: Optional[int] = None
    timestamp: Optional[float] = None

@dataclass
class ExecutionTrace:
    """
    The full runtime trajectory of a skill execution.
    Used for 'White-box Diagnosis'.
    """
    input_case: Dict[str, Any]  # The test input
    steps: List[Step] = field(default_factory=list)
    result: Optional[str] = None
    error: Optional[str] = None
    success: bool = False
    
    # Metadata for VoltAgent-style observability
    metadata: Dict[str, Any] = field(default_factory=dict)

    def get_thoughts(self) -> List[str]:
        return [s.content for s in self.steps if s.type == StepType.THOUGHT]

    def get_tool_calls(self) -> List[Dict[str, Any]]:
        return [
            {"name": s.tool_name, "args": s.tool_args, "output": next_step.content if next_step else None}
            for i, s in enumerate(self.steps)
            if s.type == StepType.ACTION
            and (next_step := self.steps[i+1] if i+1 < len(self.steps) else None)
        ]

    def summary(self) -> str:
        """Generate a concise summary for the LLM Diagnostician."""
        lines = [f"Input: {self.input_case}"]
        for s in self.steps:
            prefix = f"[{s.type.name}]"
            content = s.content[:100] + "..." if len(s.content) > 100 else s.content
            lines.append(f"{prefix} {content}")
        if self.error:
            lines.append(f"[ERROR] {self.error}")
        lines.append(f"Result: {self.result}")
        return "\n".join(lines)
