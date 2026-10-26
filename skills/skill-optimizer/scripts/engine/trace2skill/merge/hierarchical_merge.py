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
Hierarchical Merge for Trace2Skill Stage 3.

Based on arXiv:2603.25158v3 - Section 2.4

Hierarchical merging with programmatic conflict prevention:
- Groups of up to B_merge patches are synthesized at each level
- L = ceil(log_B(|P|)) levels total
- Merge operator: dedup, resolve conflicts, preserve unique insights
- Prevalence-weighted consolidation for inductive reasoning
"""

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

from ..patch import PatchPool, SkillPatch, cleanup_json_fences

logger = logging.getLogger(__name__)


MERGE_OPERATOR_SYSTEM_PROMPT = """You are a skill edit coordinator. You receive multiple independently-proposed patches that each suggest changes to a skill folder. Your job is to merge them into one coherent, non-redundant patch.

Guidelines:
1. Deduplicate: When multiple patches propose the same or very similar edits, keep the best version (most specific, best worded).
2. Resolve conflicts: If patches propose contradictory edits to the same section, choose the one with stronger justification or synthesize both into a better edit.
3. Preserve unique insights: Different patches address different failures — include all unique, non-redundant edits.
4. Maintain conciseness: The merged patch should have ≤ the sum of unique edits across all input patches. Remove redundancy.
5. Ensure independence: Edits in the merged patch MUST be line-level independent — no two edits may target overlapping lines or the same passage of text, even across different operations.
6. Atomic create/link pairs: A create operation for references/*.md and the SKILL.md edit that inserts a link to it are an inseparable pair — keep both or drop both.

Prevalent pattern bias: When multiple patches independently propose similar edits addressing the same class of failure or success pattern, treat this recurrence as evidence of a systematic property of the task. Preserve such prevalent edits with higher priority and express them as general principles rather than instance-specific fixes.
"""

OUTPUT_FORMAT_PROMPT = """Output Format:
You MUST output your merge result in the following JSON format. Do not include any additional text outside of this JSON object:
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
    ]
}
"""

@dataclass
class MergeConfig:
    batch_size: int = 32
    max_levels: int = 4
    check_file_existence: bool = True
    check_conflicts: bool = True
    skill_root: Optional[Path] = None


@dataclass
class MergeResult:
    final_patch: Optional[SkillPatch] = None
    reasoning: str = ""
    levels_completed: int = 0
    patches_merged: int = 0
    conflicts_detected: list[str] = field(default_factory=list)
    unique_patterns: list[str] = field(default_factory=list)
    low_frequency_patches: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "final_patch": self.final_patch.to_dict() if self.final_patch else "",
            "reasoning": self.reasoning,
            "levels_completed": self.levels_completed,
            "patches_merged": self.patches_merged,
            "conflicts_detected": self.conflicts_detected,
            "unique_patterns": self.unique_patterns,
            "low_frequency_patches": self.low_frequency_patches,
            "metadata": self.metadata
        }


class HierarchicalMerge:
    def __init__(
        self,
        llm_client: Callable[[str], str],
        config: Optional[MergeConfig] = None,
    ):
        self.llm_client = llm_client
        self.config = config or MergeConfig()

    def merge(
        self,
        patch_pool: PatchPool,
        skill_content: str,
    ) -> MergeResult:
        patches = self._apply_guardrails(patch_pool.patches)

        if not patches:
            logger.warning("No patches to merge after guardrails")
            return MergeResult(
                final_patch=None,
                reasoning="No patches to merge",
            )

        logger.info(f"Starting hierarchical merge with {len(patches)} patches")

        current_patches = patches
        levels_completed = 0

        while len(current_patches) > 1 and levels_completed < self.config.max_levels:
            batch_size = self.config.batch_size
            next_patches = []

            for i in range(0, len(current_patches), batch_size):
                batch = current_patches[i:i + batch_size]
                if len(batch) == 1 and i + batch_size >= len(current_patches):
                    next_patches.extend(batch)
                    break

                merged = self._merge_batch(batch, skill_content)
                if merged:
                    next_patches.append(merged)

            current_patches = next_patches
            levels_completed += 1

            logger.info(
                f"Level {levels_completed}: {len(current_patches)} patches remaining"
            )

        if not current_patches:
            logger.warning("All patches eliminated during merging")
            return MergeResult(
                final_patch=None,
                reasoning="All patches eliminated",
            )

        final_patch = current_patches[0]
        return MergeResult(
            final_patch=final_patch,
            reasoning=final_patch.reasoning,
            levels_completed=levels_completed,
            patches_merged=len(patches),
        )

    def _apply_guardrails(self, patches: list[SkillPatch]) -> list[SkillPatch]:
        valid_patches = []
        conflicts = []

        for patch in patches:
            is_valid = True

            if self.config.check_file_existence and self.config.skill_root:
                for edit in patch.edits:
                    file_path = self.config.skill_root / edit.file
                    if str(edit.file).startswith("references/"):
                        continue
                    if not file_path.exists() and not edit.file.startswith("references/"):
                        logger.warning(
                            f"Patch {patch.patch_id} references non-existent file: {edit.file}"
                        )
                        is_valid = False

            if self.config.check_conflicts:
                for other in patches:
                    if other.patch_id == patch.patch_id:
                        continue
                    if self._has_conflict(patch, other):
                        conflicts.append(f"{patch.patch_id} <-> {other.patch_id}")

            if is_valid:
                valid_patches.append(patch)

        logger.info(
            f"Guardrails: {len(patches)} -> {len(valid_patches)} patches, "
            f"{len(conflicts)} conflicts detected"
        )

        return valid_patches

    def _has_conflict(self, patch_a: SkillPatch, patch_b: SkillPatch) -> bool:
        for edit_a in patch_a.edits:
            for edit_b in patch_b.edits:
                if edit_a.file != edit_b.file:
                    continue
                if edit_a.target_start_line and edit_a.target_end_line:
                    if edit_b.target_start_line and edit_b.target_end_line:
                        if (
                            edit_a.target_start_line <= edit_b.target_end_line
                            and edit_a.target_end_line >= edit_b.target_start_line
                        ):
                            return True
        return False

    def _merge_batch(
        self,
        patches: list[SkillPatch],
        skill_content: str,
    ) -> Optional[SkillPatch]:
        patch_summaries = []
        for patch in patches:
            summary = f"### Patch {patch.patch_id}"
            if patch.source_trajectory_id:
                summary += f" (from {patch.source_trajectory_id})"
            summary += f"\n{patch.reasoning}\n"
            if patch.edits:
                summary += "\nEdits:\n"
                for edit in patch.edits:
                    summary += f"- {edit.operation} {edit.file}"
                    if edit.target:
                        summary += f" @ {edit.target}"
                    summary += "\n"
            patch_summaries.append(summary)

        prompt = "\n\n".join([
            "## System",
            MERGE_OPERATOR_SYSTEM_PROMPT,
            "",
            "## Skill Content",
            skill_content,
            "",
            f"## Patches to Merge ({len(patches)} patches)",
            "\n\n".join(patch_summaries),
            "",
            "## Instructions",
            "Merge these patches into a single coherent patch following the guidelines. ",
            OUTPUT_FORMAT_PROMPT
        ])

        response = self.llm_client(prompt)
        cleaned_response = cleanup_json_fences(response)
        return SkillPatch.from_json(cleaned_response)