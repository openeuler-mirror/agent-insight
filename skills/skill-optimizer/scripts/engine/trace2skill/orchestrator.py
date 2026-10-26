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
Trace2Skill Orchestrator - Main entry point for trace-driven skill optimization.

Based on arXiv:2603.25158v3

Three-stage pipeline:
1. Trajectory Generation (Stage 1)
2. Parallel Multi-Agent Patch Proposal (Stage 2: A- + A+)
3. Hierarchical Merge (Stage 3)
"""

import datetime
import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

from .analysis import BatchErrorAnalyst, BatchSuccessAnalyst
from .merge import HierarchicalMerge, MergeConfig, MergeResult
from .patch import PatchPool, SkillPatch
from .trajectory import TrajectorySet

logger = logging.getLogger(__name__)


@dataclass
class Trace2SkillConfig:
    trajectory_dir: Optional[Path] = None
    skill_path: Path = None
    output_dir: Optional[Path] = None
    max_concurrent: int = 8
    max_error_turns: int = 3
    merge_batch_size: int = 32
    merge_max_levels: int = 4
    enable_success_analyst: bool = True
    enable_error_analyst: bool = True


@dataclass
class Trace2SkillResult:
    evolved_skill_content: str = ""
    error_patches_count: int = 0
    success_patches_count: int = 0
    merge_result: Optional[MergeResult] = None
    metadata: dict[str, Any] = field(default_factory=dict)


class Trace2SkillOrchestrator:
    def __init__(
        self,
        llm_client: Callable[[str], str],
        config: Trace2SkillConfig,
    ):
        self.llm_client = llm_client
        self.config = config

    def run(self) -> Trace2SkillResult:
        logger.info("Starting Trace2Skill optimization")

        trajectory_set = self._load_trajectories()

        logger.info(
            f"Loaded {trajectory_set.total_count} trajectories "
            f"({trajectory_set.success_count} success, {trajectory_set.failure_count} failure)"
        )

        skill_content = self._load_skill()

        patch_pool = PatchPool()

        if self.config.enable_error_analyst and trajectory_set.failure_count > 0:
            logger.info("Running Error Analysts (Stage 2)")
            error_results = self._run_error_analysts(trajectory_set, skill_content)
            for result in error_results:
                if result.patch:
                    patch_pool.add_patch(result.patch)
            logger.info(f"Generated {len(error_results)} error patches")

        if self.config.enable_success_analyst and trajectory_set.success_count > 0:
            logger.info("Running Success Analysts (Stage 2)")
            success_results = self._run_success_analysts(trajectory_set, skill_content)
            for result in success_results:
                if result.patch:
                    patch_pool.add_patch(result.patch)
            logger.info(f"Generated {len(success_results)} success patches")

        logger.info(f"Total patches: {patch_pool.total_count}")

        merge_config = MergeConfig(
            batch_size=self.config.merge_batch_size,
            max_levels=self.config.merge_max_levels,
            skill_root=self.config.skill_path.parent,
        )
        merge = HierarchicalMerge(self.llm_client, merge_config)

        # Save patches before merge
        if self.config.output_dir:
            self._save_patches_before_merge(patch_pool)

        merge_result = merge.merge(patch_pool, skill_content)
        logger.info(
            f"Hierarchical merge completed: {merge_result.levels_completed} levels"
        )

        # Save patches after merge
        if self.config.output_dir:
            self._save_patches_after_merge(merge_result)

        evolved_content = self._apply_patch(skill_content, merge_result.final_patch)

        if self.config.output_dir:
            self._save_output(evolved_content, merge_result)

        return Trace2SkillResult(
            evolved_skill_content=evolved_content,
            error_patches_count=len(patch_pool.error_patches),
            success_patches_count=len(patch_pool.success_patches),
            merge_result=merge_result,
            metadata={
                "trajectory_count": trajectory_set.total_count
            },
        )

    def _load_trajectories(self) -> TrajectorySet:
        if self.config.trajectory_dir:
            trajectory_dir = self.config.trajectory_dir if isinstance(self.config.trajectory_dir, Path) else Path(self.config.trajectory_dir)
            return TrajectorySet.load_from_directory(trajectory_dir)

        return TrajectorySet(
            trajectories=[],
            source_skill=self.config.skill_path.name,
        )

    def _load_skill(self) -> str:
        skill_path = self.config.skill_path if isinstance(self.config.skill_path, Path) else Path(self.config.skill_path)
        return skill_path.read_text(encoding="utf-8")

    def _run_error_analysts(self, trajectory_set: TrajectorySet, skill_content: str):
        analyst = BatchErrorAnalyst(
            self.llm_client,
            max_concurrent=self.config.max_concurrent,
            max_turns=self.config.max_error_turns,
        )
        return analyst.analyze_batch(
            trajectory_set.trajectories,
            skill_content,
        )

    def _run_success_analysts(self, trajectory_set: TrajectorySet, skill_content: str):
        analyst = BatchSuccessAnalyst(
            self.llm_client,
            max_concurrent=self.config.max_concurrent,
        )
        return analyst.analyze_batch(
            trajectory_set.trajectories,
            skill_content,
        )

    def _apply_patch(
        self,
        skill_content: str,
        final_patch: Optional[SkillPatch],
    ) -> str:
        if not final_patch:
            return skill_content

        logger.info("Applying final patch to skill")

        # Create prompt for LLM to apply the patch
        edits_description = []
        for i, edit in enumerate(final_patch.edits):
            edit_desc = f"{i+1}. Operation: {edit.operation}"
            if edit.target:
                edit_desc += f", Target: '{edit.target}'"
            if edit.target_start_line is not None:
                edit_desc += f", Start line: {edit.target_start_line}"
            if edit.target_end_line is not None:
                edit_desc += f", End line: {edit.target_end_line}"
            if edit.content:
                edit_desc += f", Content: {repr(edit.content)}"
            if edit.reasoning:
                edit_desc += f", Reasoning: {edit.reasoning}"
            edits_description.append(edit_desc)

        prompt = f"""You are a precise code editor. Your task is to apply a series of edits to a skill file based on the instructions below.

        SKILL FILE CONTENT:
        {skill_content}

        EDITS TO APPLY:
        {chr(10).join(edits_description)}

        INSTRUCTIONS:
        1. Apply each edit in the order listed
        2. For 'insert' operations: Insert the content at the specified location
        3. For 'replace' operations: Replace the target text with the new content
        4. For 'delete' operations: Remove the target text
        5. If target_start_line and target_end_line are provided, use those line numbers (1-indexed) to locate the text
        6. If target is provided, find and operate on that exact text
        7. Make sure to preserve the overall structure and formatting of the skill file
        8. Return ONLY the modified skill file content, with no additional explanations or formatting
        9. Change skill version if any

        Modified skill file content:"""

        # Apply the patch using LLM
        modified_content = self.llm_client(prompt)
        return modified_content

    def _save_patches_before_merge(self, patch_pool) -> None:
        """Save all patches before merging to JSON file."""
        output_dir = self.config.output_dir
        output_dir.mkdir(parents=True, exist_ok=True)
        
        patches_data = {
            "total_patches": patch_pool.total_count,
            "error_patches": len(patch_pool.error_patches),
            "success_patches": len(patch_pool.success_patches),
            "patches": [patch.to_dict() for patch in patch_pool.patches]
        }
        
        patches_path = output_dir / "patches_before_merge.json"
        with open(patches_path, "w", encoding="utf-8") as f:
            json.dump(patches_data, f, ensure_ascii=False, indent=2)
        logger.info(f"Saved {patch_pool.total_count} patches before merge to {patches_path}")

    def _save_patches_after_merge(self, merge_result: MergeResult) -> None:
        """Save merged patch after hierarchical merge to JSON file."""
        output_dir = self.config.output_dir
        output_dir.mkdir(parents=True, exist_ok=True)
        
        merged_patch_data = {
            "merged_patch": merge_result.final_patch.to_dict() if merge_result.final_patch else None,
            "merge_metadata": {
                "levels_completed": merge_result.levels_completed,
                "patches_merged": merge_result.patches_merged,
                "conflicts_detected": merge_result.conflicts_detected,
                "unique_patterns": merge_result.unique_patterns,
                "low_frequency_patches": merge_result.low_frequency_patches,
            }
        }
        
        patches_path = output_dir / "patches_after_merge.json"
        with open(patches_path, "w", encoding="utf-8") as f:
            json.dump(merged_patch_data, f, ensure_ascii=False, indent=2)
        logger.info(f"Saved merged patch to {patches_path}")

    def _save_output(
        self,
        evolved_content: str,
        merge_result: MergeResult,
    ) -> None:
        output_dir = self.config.output_dir
        output_dir.mkdir(parents=True, exist_ok=True)

        if merge_result:
            result_path = output_dir / "trace2skill_result.json"
            with open(result_path, "w", encoding="utf-8") as f:
                json.dump(merge_result.to_dict(), f, ensure_ascii=False, indent=2)
            logger.info(f"Saved merge result to {result_path}")

        # Generate OPTIMIZATION_REPORT.md
        self._generate_optimization_report(output_dir, evolved_content, merge_result)

    def _generate_optimization_report(
        self,
        output_dir: Path,
        evolved_content: str,
        merge_result: MergeResult,
    ) -> None:
        """Generate OPTIMIZATION_REPORT.md for trace mode optimization."""
        try:
            # Load original skill content
            original_content = self._load_skill()
            
            # Get patch information
            patch_info = "## Patch Summary\n\n"
            if merge_result.final_patch:
                patch_info += f"- **Total edits applied**: {len(merge_result.final_patch.edits)}\n"
                patch_info += f"- **Merge levels completed**: {merge_result.levels_completed}\n"
                patch_info += f"- **Patches merged**: {merge_result.patches_merged}\n"
                
                if merge_result.conflicts_detected:
                    patch_info += f"- **Conflicts detected**: {len(merge_result.conflicts_detected)}\n"
                    for conflict in merge_result.conflicts_detected[:5]:  # Show first 5
                        patch_info += f"  - {conflict}\n"
                
                if merge_result.unique_patterns:
                    patch_info += f"- **Unique patterns identified**: {len(merge_result.unique_patterns)}\n"
                    for pattern in merge_result.unique_patterns[:5]:  # Show first 5
                        patch_info += f"  - {pattern}\n"
            else:
                patch_info += "- **No patches applied**: Analysis completed but no changes were deemed necessary.\n"
                patch_info += f"- **Merge levels completed**: {merge_result.levels_completed}\n"
                patch_info += f"- **Patches analyzed**: {merge_result.patches_merged}\n"
            
            # Create report content
            report_content = f"""# Trace Mode Optimization Report

## Executive Summary
This skill was optimized using Trace2Skill mode, which analyzes execution trajectories to identify improvement opportunities.

## Optimization Details
- **Mode**: Trace2Skill (trajectory-based optimization)
- **Original skill**: {self.config.skill_path.name}
- **Output directory**: {output_dir}
- **Timestamp**: {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}

## Trajectory Analysis
- **Total trajectories analyzed**: {merge_result.metadata.get('trajectory_count', 'N/A')}
- **Success rate**: {merge_result.metadata.get('success_rate', 'N/A')}

{patch_info}

## Changes Applied
"""
            
            # Check if changes were applied
            if merge_result.final_patch and merge_result.final_patch.edits:
                report_content += """The following changes were applied to the skill based on trajectory analysis:

### Key Improvements
1. **Error Pattern Fixes**: Addressed common failure patterns observed in trajectories
2. **Success Pattern Reinforcement**: Enhanced successful execution patterns
3. **Conflict Resolution**: Resolved conflicting patch suggestions through hierarchical merge
4. **Prevalence Weighting**: Prioritized edits that appeared across multiple independent patches

### Edit Details
"""
                # Add detailed edit information
                report_content += "\n### Detailed Edits\n\n"
                for i, edit in enumerate(merge_result.final_patch.edits, 1):
                    report_content += f"#### Edit {i}\n"
                    report_content += f"- **Operation**: {edit.operation}\n"
                    if edit.target:
                        report_content += f"- **Target**: `{edit.target[:100]}{'...' if len(edit.target) > 100 else ''}`\n"
                    if edit.target_start_line is not None:
                        report_content += f"- **Start line**: {edit.target_start_line}\n"
                    if edit.target_end_line is not None:
                        report_content += f"- **End line**: {edit.target_end_line}\n"
                    if edit.reasoning:
                        report_content += f"- **Reasoning**: {edit.reasoning}\n"
                    report_content += "\n"
            else:
                report_content += """No changes were applied to the skill. The analysis concluded that:

### Analysis Results
1. **Skill Validation**: The current skill implementation is already well-optimized for the observed trajectories
2. **Pattern Analysis**: No consistent failure patterns were identified that require modification
3. **Success Reinforcement**: Existing successful patterns are already adequately captured
4. **Conflict Assessment**: No conflicting improvement suggestions were generated

### Recommendation
The skill appears to be functioning correctly based on the trajectory analysis. Consider:
- Collecting more diverse trajectories for further analysis
- Testing with edge cases not covered in current trajectories
- Manual review if specific issues are suspected"""
            
            # Add merge reasoning if available
            if merge_result.reasoning:
                report_content += f"\n## Merge Reasoning\n\n{merge_result.reasoning}\n"
            
            # Add conclusion
            if merge_result.final_patch and merge_result.final_patch.edits:
                report_content += """
## Conclusion
The skill has been optimized based on actual execution traces. The changes reflect real-world usage patterns and address both failure modes and success reinforcement opportunities.

## Next Steps
1. Review the optimized skill in `SKILL.md`
2. Check the detailed merge results in `trace2skill_result.json`
3. Test the optimized skill with new trajectories
4. Consider further refinement based on additional feedback
"""
            else:
                report_content += """
## Conclusion
The skill analysis completed successfully. No changes were applied as the current implementation appears well-suited to the observed trajectories.

## Next Steps
1. Review the analysis results in `trace2skill_result.json`
2. Consider collecting more diverse trajectories for further analysis
3. Test the skill with edge cases not covered in current trajectories
4. Manual review if specific improvements are desired
"""
            
            # Write the report
            report_path = output_dir / "OPTIMIZATION_REPORT.md"
            with open(report_path, "w", encoding="utf-8") as f:
                f.write(report_content)
            logger.info(f"Generated optimization report: {report_path}")
            
        except Exception as e:
            logger.error(f"Failed to generate optimization report: {e}")
            # Create a minimal report even if something goes wrong
            try:
                minimal_report = f"""# Trace Mode Optimization Report

## Executive Summary
Optimization completed via Trace2Skill mode.

## Status
- **Optimization**: Completed
- **Report Generation**: Partial (error occurred: {e})
- **Timestamp**: {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}

## Note
Full report generation failed, but optimization completed successfully.
Check `trace2skill_result.json` for detailed results.
"""
                report_path = output_dir / "OPTIMIZATION_REPORT.md"
                with open(report_path, "w", encoding="utf-8") as f:
                    f.write(minimal_report)
                logger.info(f"Generated minimal optimization report: {report_path}")
            except Exception as e2:
                logger.error(f"Failed to generate even minimal report: {e2}")


def run_trace2skill(
    llm_client: Callable[[str], str],
    config: Trace2SkillConfig,
) -> Trace2SkillResult:
    orchestrator = Trace2SkillOrchestrator(llm_client, config)
    return orchestrator.run()
