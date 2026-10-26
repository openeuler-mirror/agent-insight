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

from abc import ABC, abstractmethod
from typing import Dict, Any, List
from architecture.genome import SkillGenome
from architecture.trace import ExecutionTrace

class BaseRunner(ABC):
    """
    Abstract interface for the Skill Simulator (Runner).
    Follows VoltAgent's Runner pattern: Input -> Runner -> Output+Trace.
    """

    @abstractmethod
    def run_case(self, genome: SkillGenome, input_case: Dict[str, Any]) -> ExecutionTrace:
        """
        Execute a single test case using the provided Skill Genome.
        
        Args:
            genome: The 5D Skill variant to test.
            input_case: The input data (e.g. {"query": "check memory"}).
            
        Returns:
            ExecutionTrace: The complete runtime trajectory.
        """
        pass

    def run_batch(self, genome: SkillGenome, batch: List[Dict[str, Any]]) -> List[ExecutionTrace]:
        """
        Run a batch of test cases (sequentially or parallel).
        """
        traces = []
        for case in batch:
            try:
                traces.append(self.run_case(genome, case))
            except Exception as e:
                # Fallback trace for catastrophic runner failures
                from optimization.architecture.trace import ExecutionTrace, Step, StepType
                t = ExecutionTrace(input_case=case, error=str(e))
                t.steps.append(Step(StepType.ERROR, content=f"Runner crashed: {e}"))
                traces.append(t)
        return traces
