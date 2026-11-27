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

import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

from architecture.genome import SkillGenome
from architecture.scoring import Diagnosis
from engine.crystallizer import ExperienceCrystallizer, ReportParser
from engine.evaluation_adapter import EvaluationAdapter
from engine.mutator import DiagnosticMutator

logger = logging.getLogger(__name__)


class SkillOptimizer:
    """
    The Main Controller for the new "Static/Dynamic" Optimization Strategy.

    Strategy:
    1. Cold Start: Static 5D Evaluation -> Immediate Fix.
    2. Dynamic Run: Trace Analysis -> Experience Crystallization (Injection).
    """

    def __init__(
        self,
        evaluator: EvaluationAdapter,
        mutator: DiagnosticMutator,
        crystallizer: ExperienceCrystallizer,
    ):
        self.evaluator = evaluator
        self.mutator = mutator
        self.crystallizer = crystallizer

    @classmethod
    def from_llm_client(cls, llm_client: Any) -> "SkillOptimizer":
        """
        Factory method to create a SkillOptimizer with standard components from an LLM client.
        This encapsulates the wiring logic, keeping main.py clean while preserving Dependency Injection.
        """
        mutator = DiagnosticMutator(model_client=llm_client)
        evaluator = EvaluationAdapter(model_client=llm_client)
        parser = ReportParser(model_client=llm_client)
        crystallizer = ExperienceCrystallizer(parser, mutator)
        return cls(evaluator, mutator, crystallizer)

    def optimize_static(
        self,
        skill_path: Path,
        trace_id: Optional[str] = None,
        human_feedback: Optional[str] = None,
    ):
        """
        [Cold Start]
        Perform a static 5D health check on the skill content and apply fixes.
        Does NOT require running the skill.
        Returns: (optimized_genome, diagnoses)
        """
        logger.info(">>> Starting Static Optimization (Cold Start)...")

        # 1. Parse from Directory (supports files)
        try:
            genome = SkillGenome.from_directory(skill_path.parent)
        except Exception as e:
            logger.warning(
                f"Could not load from directory, falling back to file content. Error: {e}"
            )
            with open(skill_path, "r", encoding="utf-8") as f:
                genome = SkillGenome.from_markdown(f.read())

        # 2. Static Evaluate (Pass empty trace list)
        eval_result = self.evaluator.evaluate(
            genome, traces=[], trace_id=trace_id, human_feedback=human_feedback
        )

        # 3. Diagnose
        # Filter for static issues (exclude execution anomalies if any leak in)
        static_diagnoses = [
            d for d in eval_result.diagnoses if d.dimension != "Execution"
        ]

        # Note: If human feedback is present, we force mutation even if static_diagnoses is empty
        # because the human might be asking for a change that the evaluator didn't catch.
        # So we check if diagnoses exist OR reflection (feedback) is present.

        has_feedback = bool(
            eval_result.reflection
            and eval_result.reflection != "Combined diagnostics..."
        )

        if not static_diagnoses and not has_feedback:
            logger.info(
                ">>> No static issues found and no feedback provided. Skill is healthy."
            )
            return genome, []

        logger.info(
            f">>> Found {len(static_diagnoses)} static issues (and feedback present: {has_feedback}). Applying fixes..."
        )
        for d in static_diagnoses:
            logger.info(f"    - [{d.dimension}] {d.description}")

        if has_feedback:
            logger.info(f"    - [Human Feedback] {eval_result.reflection[:100]}...")

        # 4. Mutate
        variants = self.mutator.mutate(
            genome,
            static_diagnoses,
            trace_id=trace_id,
            reflection=eval_result.reflection,  # Pass the reflection (feedback) here
        )

        if variants:
            best_variant = variants[0]  # In static mode, we trust the repair
            return best_variant, static_diagnoses

        return genome, static_diagnoses

    def optimize_feedback(
        self,
        skill_path: Path,
        trace_id: Optional[str] = None,
        human_feedback: Optional[str] = None,
    ):
        logger.info(">>> Starting Feedback Optimization (User Revision)...")

        try:
            genome = SkillGenome.from_directory(skill_path.parent)
        except Exception as e:
            logger.warning(
                f"Could not load from directory, falling back to file content. Error: {e}"
            )
            with open(skill_path, "r", encoding="utf-8") as f:
                genome = SkillGenome.from_markdown(f.read())

        feedback = (human_feedback or "").strip()
        if not feedback:
            logger.info(">>> No feedback provided. Skipping feedback optimization.")
            return genome, []

        variants = self.mutator.mutate(
            genome,
            diagnoses=[],
            trace_id=trace_id,
            reflection=feedback,
        )

        if variants:
            return variants[0], []

        return genome, []

    def optimize_dynamic(
        self,
        genome: SkillGenome,
        report_items: Optional[List[Dict[str, Any]]] = None,
        trace_id: Optional[str] = None,
    ):
        """
        [Dynamic Run]
        Trace Analysis -> Experience Crystallization.
        Returns: (optimized_genome, diagnoses)
        """
        logger.info(">>> Starting Dynamic Optimization (Experience Crystallization)...")

        if report_items:
            return self.crystallizer.crystallize(genome, report_items)
        else:
            logger.warning("No reports found for dynamic run. Skipping.")
            return genome, []

    def optimize_hybrid(
        self,
        skill_path: Path,
        report_items: Optional[List[Dict[str, Any]]] = None,
        trace_id: Optional[str] = None,
        human_feedback: Optional[str] = None,
    ):
        """
        [Hybrid Run]
        Pipeline: Static Optimization -> Dynamic Optimization.
        Ensures the skill is structurally sound before injecting experience.
        Returns: (optimized_genome, all_diagnoses)
        """
        logger.info(">>> Starting Hybrid Optimization (Static + Dynamic)...")

        # 1. Run Static Optimization (Inject Feedback Here)
        genome_after_static, static_diagnoses = self.optimize_static(
            skill_path, trace_id=trace_id, human_feedback=human_feedback
        )

        # 2. Run Dynamic Optimization
        try:
            # We pass the genome from static step
            # Note: We don't pass feedback again to dynamic optimization to avoid double application
            genome_final, dynamic_diagnoses = self.optimize_dynamic(
                genome_after_static, report_items, trace_id=trace_id
            )

            # Merge diagnoses
            all_diagnoses = static_diagnoses + dynamic_diagnoses
            return genome_final, all_diagnoses

        except Exception as e:
            logger.error(f"Dynamic Optimization failed in Hybrid mode: {e}")
            import traceback

            traceback.print_exc()
            # Fallback to static result so we don't lose everything
            return genome_after_static, static_diagnoses
        
    def optimize_trace(
        self,
        skill_path: Path,
        trajectories: Path,
        project_path: Optional[Path] = None,
    ):
        """
        [Trace-Driven Run]
        Analyze execution trajectories and distill lessons into skill improvements.
        Returns: (optimized_genome, diagnoses)
        """
        from engine.trace2skill import Trace2SkillConfig, run_trace2skill

        logger.info(">>> Starting Trace-Driven Optimization...")

        trajectories_path = Path(trajectories)
        if not trajectories_path.exists():
            logger.error(f"Trajectories directory not found: {trajectories_path}")
            return None, []

        skill_path = Path(skill_path)
        if not skill_path.exists():
            logger.error(f"Skill path not found: {skill_path}")
            return None, []

        try:
            genome = SkillGenome.from_directory(skill_path.parent)
        except Exception as e:
            logger.warning(f"Could not load from directory, falling back to file content: {e}")
            with open(skill_path, "r", encoding="utf-8") as f:
                genome = SkillGenome.from_markdown(f.read())

        output_dir = Path(project_path) if project_path else None

        config = Trace2SkillConfig(
            trajectory_dir=trajectories_path,
            skill_path=skill_path,
            output_dir=output_dir,
            enable_success_analyst=True,
            enable_error_analyst=True,
        )

        result = run_trace2skill(llm_client=self.mutator.model_client, config=config)

        logger.info(
            f">>> Trace2Skill completed: {result.error_patches_count} error patches, "
            f"{result.success_patches_count} success patches"
        )

        if not result.evolved_skill_content:
            logger.warning("No evolved skill content returned")
            return genome, []

        evolved_genome = SkillGenome.from_markdown(result.evolved_skill_content)

        try:
            evolved_genome.files = genome.files.copy()
            evolved_genome.file_meta = genome.file_meta.copy()
        except Exception as e:
            logger.warning(f"Could not preserve auxiliary files: {e}")

        diagnoses = []
        if result.merge_result and result.merge_result.final_patch:
            for patch in result.merge_result.final_patch.edits:
                diagnoses.append(
                    Diagnosis(
                        dimension="Trace",
                        issue_type="trajectory_based",
                        severity="info",
                        description=patch.reasoning or "Trajectory-driven improvement",
                        evidence=f"Patch: {patch.operation}",
                        suggested_fix=patch.content if patch.content else "",
                    )
                )

        return evolved_genome, diagnoses
        
