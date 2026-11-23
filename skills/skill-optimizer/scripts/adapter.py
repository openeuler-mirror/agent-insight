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

from typing import List, Dict, Any
from dataclasses import asdict

from gepa import GEPAAdapter, EvaluationBatch
from architecture.genome import SkillGenome
from engine.runner import BaseRunner
from engine.evaluation_adapter import EvaluationAdapter
from architecture.trace import ExecutionTrace


class OptimizationAdapter(GEPAAdapter):
    """
    Adapter to bridge GEPA's optimization loop with our 5D Engine.
    """

    def __init__(self, runner: BaseRunner, evaluator: EvaluationAdapter):
        super().__init__()
        self.runner = runner
        self.evaluator = evaluator
        self.history = []

    def evaluate(
        self, batch: List[Any], candidate: Dict[str, str], capture_traces: bool = False
    ) -> EvaluationBatch:
        """
        Run the candidate skill against the batch using the Simulator (Runner).
        Then evaluate using the 5D Evaluator.
        """

        # 1. Parse candidate into Genome
        skill_text = candidate.get("skill_md", "")
        genome = SkillGenome.from_markdown(skill_text)

        # 2. Run Simulation (Trace Generation)
        # batch here is the list of test cases (Dynamic Dataset)
        traces: List[ExecutionTrace] = self.runner.run_batch(genome, batch)

        # 3. Diagnostic Evaluation
        eval_result = self.evaluator.evaluate(genome, traces)

        # 4. Construct GEPA Return Object
        # GEPA expects a single scalar score for sorting usually, but we can store 5D in details.
        # We use the average score as the primary fitness for GEPA's internal sorting if needed.
        final_score = eval_result.scores.average()

        # Record history
        self.history.append({"genome": genome, "traces": traces, "result": eval_result})

        # Construct EvaluationBatch
        # We map our traces to GEPA trajectories
        trajectories = []
        outputs = []
        scores = []

        for t in traces:
            trajectories.append(
                {
                    "input": str(t.input_case),
                    "output": t.result,
                    "score": final_score,  # We assign the aggregate score to each trace for now
                    "feedback": eval_result.reflection,  # The reflection is shared
                    "diagnosis": [
                        asdict(d) for d in eval_result.diagnoses
                    ],  # Custom field
                }
            )
            outputs.append(t.result or "")
            scores.append(final_score)

        return EvaluationBatch(
            outputs=outputs, scores=scores, trajectories=trajectories
        )

    def make_reflective_dataset(
        self,
        candidate: Dict[str, str],
        eval_batch: EvaluationBatch,
        components_to_update: List[str],
    ):
        """
        Convert evaluation results into feedback for the Mutator.
        In standard GEPA, this creates a dataset for the 'Reflector' LLM.
        Here, we can pass our structured Diagnoses.
        """
        dataset = {}
        # In our architecture, the Mutator uses the Diagnoses directly.
        # We can pass the Diagnoses as the 'feedback' string if we want to hack it,
        # or just ignore this if we use our custom Mutator logic outside GEPA's standard loop.

        # If we use GEPA's loop, it will call Proposer with this dataset.
        # We might need to serialize diagnoses into text.

        trajs = []
        for traj in eval_batch.trajectories:
            diagnosis_str = "\n".join(
                [
                    f"- [{d['dimension']}] {d['description']}"
                    for d in traj.get("diagnosis", [])
                ]
            )

            trajs.append(
                {
                    "score": traj["score"],
                    "feedback": f"Diagnosis:\n{diagnosis_str}\n\nReflection:\n{traj['feedback']}",
                    "program_input": traj["input"],
                    "program_output": traj["output"],
                }
            )

        for comp in components_to_update:
            dataset[comp] = trajs

        return dataset
