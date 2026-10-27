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

from typing import List, Optional
from architecture.genome import SkillGenome
from architecture.trace import ExecutionTrace
from architecture.scoring import (
    EvaluationResult,
    ScoreVector,
    Diagnosis,
)
from engine.linter import SkillLinter

try:
    from evaluation.evaluate_skill import SkillEvaluator
except ImportError:
    SkillEvaluator = None


class EvaluationAdapter:
    """
    The 5D Evaluation Adapter.
    Orchestrates:
    1. Pre-flight Check (SkillLinter) - Hard Rules
    2. Static Analysis (LLM) - Soft Rules (5D)
    3. Dynamic Analysis (Trace Detective) - Execution
    """

    def __init__(self, model_client=None):
        self.model_client = model_client  # e.g. DeepSeek/OpenAI client
        self.linter = SkillLinter()

    def evaluate(
        self,
        genome: SkillGenome,
        traces: List[ExecutionTrace],
        trace_id: Optional[str] = None,
        human_feedback: Optional[str] = None,
    ) -> EvaluationResult:
        """
        Main entry point.
        Combines Linter + Static LLM + Dynamic Trace Analysis.
        """
        all_diagnoses = []

        # 1. Pre-flight Check (Linter)
        # Check raw text for hard compliance issues
        if genome.raw_text:
            linter_diagnoses = self.linter.lint(genome.raw_text)
            all_diagnoses.extend(linter_diagnoses)

        # 2. Static Analysis (LLM)
        static_scores, static_diagnoses = self._evaluate_static_llm(
            genome, trace_id=trace_id
        )
        all_diagnoses.extend(static_diagnoses)

        # 3. Dynamic Analysis (Trace Detective)
        # Aggregate scores from multiple traces
        trace_scores = []
        trace_diagnoses = []

        for trace in traces:
            s, d = self._evaluate_trace(trace)
            trace_scores.append(s)
            trace_diagnoses.extend(d)

        all_diagnoses.extend(trace_diagnoses)

        # 4. Merge Scores (Pareto-aware logic or simple average for now)
        # TODO: Implement sophisticated merging strategy
        final_scores = self._merge_scores(static_scores, trace_scores)

        # 5. Synthesize Reflection
        # If human feedback is provided, use it as reflection. Otherwise synthesize it.
        if human_feedback and human_feedback.strip():
            reflection = human_feedback
        else:
            reflection = self._synthesize_reflection(all_diagnoses)

        return EvaluationResult(
            scores=final_scores, diagnoses=all_diagnoses, reflection=reflection
        )

    def _evaluate_static_llm(self, genome: SkillGenome, trace_id: Optional[str] = None):
        """
        Run LLM-based code review on the 5 dimensions.
        """
        if not SkillEvaluator:
            print("Warning: Could not import SkillEvaluator")
            return ScoreVector(), []

        # 1. Get Full Content (Raw Text)
        content = genome.raw_text if genome.raw_text else genome.to_markdown()

        # 2. Call the existing evaluation logic
        # Initialize SkillEvaluator with the existing client
        # We assume self.model_client is RealLLMClient which wraps ChatOpenAI in .llm
        llm_instance = getattr(self.model_client, "llm", self.model_client)

        evaluator = SkillEvaluator(llm_instance)

        # Pass trace_id to evaluate_meta
        meta_results, meta_comment = evaluator.evaluate_meta(content, trace_id=trace_id)

        # 3. Parse results into ScoreVector and Diagnoses
        scores = ScoreVector()
        diagnoses = []

        # Map Chinese dimensions to English fields
        dim_map = {
            "职责明确性": "role",
            "结构规范性": "structure",
            "指令适配性": "instruction",
            "内容一致性": "content",
            "风险可控性": "risk",
        }

        # Map to Diagnosis dimension names (Capitalized)
        diag_dim_map = {
            "职责明确性": "Role",
            "结构规范性": "Structure",
            "指令适配性": "Instruction",
            "内容一致性": "Content",
            "风险可控性": "Risk",
        }

        for item in meta_results:
            dim_cn = item.get("dimension")
            score_val = item.get("score", 0)
            justification = item.get("justification", "")

            try:
                score = float(score_val)
            except (ValueError, TypeError):
                score = 0.0

            # Update ScoreVector
            if dim_cn in dim_map:
                field_name = dim_map[dim_cn]
                setattr(scores, field_name, score)

            # Create Diagnosis for non-perfect scores
            if score < 5.0:
                severity = "Minor"
                if score < 3.0:
                    severity = "Major"
                if score < 2.0:
                    severity = "Critical"

                diag_dim = diag_dim_map.get(dim_cn, dim_cn)

                diagnoses.append(
                    Diagnosis(
                        dimension=diag_dim,
                        issue_type="StaticEvaluation",
                        severity=severity,
                        description=justification,
                        evidence=f"Score: {score}/5",
                        suggested_fix="Follow the justification to improve this dimension.",
                    )
                )

        return scores, diagnoses

    def _evaluate_trace(self, trace: ExecutionTrace):
        """
        Run Trace Detective on a single trace.
        """
        # Placeholder
        return ScoreVector(3.0, 3.0, 3.0, 3.0, 3.0), []

    def _merge_scores(
        self, static: ScoreVector, dynamic_list: List[ScoreVector]
    ) -> ScoreVector:
        # Placeholder: simple average
        return static

    def _synthesize_reflection(self, diagnoses: List[Diagnosis]) -> str:
        # Placeholder
        return "Combined diagnostics..."
