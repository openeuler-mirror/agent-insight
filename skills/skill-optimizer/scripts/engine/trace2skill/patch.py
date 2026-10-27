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
Skill patch data structures for Trace2Skill.
"""

from dataclasses import dataclass, field
from enum import Enum
import json
import uuid
from typing import Optional


def cleanup_json_fences(text: str) -> str:
    """Strip markdown code fences (```json ... ```) from LLM responses."""
    cleaned = text.strip()
    if cleaned.startswith("```json"):
        cleaned = cleaned[7:]
    if cleaned.endswith("```"):
        cleaned = cleaned[:-3]
    return cleaned.strip()


def parse_edits_from_json(data: dict) -> list["PatchEdit"]:
    """Parse a list of PatchEdit objects from a JSON dict with an 'edits' key."""
    edits = []
    for edit_data in data.get("edits", []):
        edit = PatchEdit(
            file=edit_data.get("file", "SKILL.md"),
            operation=edit_data.get("operation", ""),
            target=edit_data.get("target", ""),
            target_start_line=edit_data.get("target_start_line"),
            target_end_line=edit_data.get("target_end_line"),
            content=edit_data.get("content", ""),
            reasoning=edit_data.get("reasoning", ""),
        )
        edits.append(edit)
    return edits


class PatchOperation(Enum):
    INSERT = "insert"
    REPLACE = "replace"
    DELETE = "delete"


@dataclass
class PatchEdit:
    file: str
    operation: PatchOperation
    reasoning: Optional[str] = None
    target: Optional[str] = None
    target_start_line: Optional[int] = None
    target_end_line: Optional[int] = None
    content: Optional[str] = None

    def to_dict(self) -> dict:
        result = {
            "file": self.file,
            "operation": self.operation,
        }
        if self.target:
            result["target"] = self.target
        if self.target_start_line is not None:
            result["target_start_line"] = self.target_start_line
        if self.target_end_line is not None:
            result["target_end_line"] = self.target_end_line
        if self.content:
            result["content"] = self.content
        if self.reasoning:
            result["reasoning"] = self.reasoning
        return result

    @classmethod
    def from_dict(cls, data: dict) -> "PatchEdit":
        return cls(
            file=data["file"],
            operation=PatchOperation(data["op"]),
            target=data.get("target"),
            target_start_line=data.get("target_start_line"),
            target_end_line=data.get("target_end_line"),
            content=data.get("content"),
            reasoning=data.get("reasoning")
        )


@dataclass
class SkillPatch:
    patch_id: str
    source_trajectory_id: Optional[str] = None
    is_from_error: bool = False
    edits: list[PatchEdit] = field(default_factory=list)
    reasoning: str = ""

    def to_dict(self) -> dict:
        return {
            "patch_id": self.patch_id,
            "source_trajectory_id": self.source_trajectory_id,
            "is_from_error": self.is_from_error,
            "edits": [e.to_dict() for e in self.edits],
            "reasoning": self.reasoning
        }

    @classmethod
    def from_dict(cls, data: dict) -> "SkillPatch":
        return cls(
            patch_id=data["patch_id"],
            source_trajectory_id=data.get("source_trajectory_id"),
            is_from_error=data.get("is_from_error", False),
            edits=[PatchEdit.from_dict(e) for e in data.get("edits", [])],
            reasoning=data.get("reasoning", "")
        )

    @classmethod
    def from_json(cls, json_str: str) -> "SkillPatch":
        cleaned_str = cleanup_json_fences(json_str)
        data = json.loads(cleaned_str)
        edits = parse_edits_from_json(data)

        return SkillPatch(
            patch_id=str(uuid.uuid4())[:8],
            source_trajectory_id=None,
            is_from_error=False,
            edits=edits,
            reasoning=""
        )


@dataclass
class PatchPool:
    patches: list[SkillPatch] = field(default_factory=list)

    @property
    def error_patches(self) -> list[SkillPatch]:
        return [p for p in self.patches if p.is_from_error]

    @property
    def success_patches(self) -> list[SkillPatch]:
        return [p for p in self.patches if not p.is_from_error]

    @property
    def total_count(self) -> int:
        return len(self.patches)

    def add_patch(self, patch: SkillPatch) -> None:
        self.patches.append(patch)

    def to_dict(self) -> dict:
        return {
            "patches": [p.to_dict() for p in self.patches],
            "summary": {
                "total": self.total_count,
                "error": len(self.error_patches),
                "success": len(self.success_patches),
            },
        }