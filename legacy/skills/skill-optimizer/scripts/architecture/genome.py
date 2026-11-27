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
import hashlib
import json
import re
from pathlib import Path
from typing import Dict, List, Optional


@dataclass
class SkillGenome:
    name: str = ""
    raw_text: str = ""
    files: Dict[str, str] = field(default_factory=dict)
    file_meta: Dict[str, str] = field(default_factory=dict)
    changelog: List[Dict[str, str]] = field(default_factory=list)
    referenced_files: set = field(default_factory=set)

    def to_markdown(self) -> str:
        return self.raw_text or ""

    @classmethod
    def from_markdown(cls, text: str) -> "SkillGenome":
        text = text or ""
        genome = cls(raw_text=text)
        genome.name = cls._extract_name_from_frontmatter(text)
        return genome

    @classmethod
    def from_directory(cls, path: str) -> "SkillGenome":
        path = Path(path)
        skill_file = path / "SKILL.md"
        if not skill_file.exists():
            raise FileNotFoundError(f"No SKILL.md found in {path}")

        content = skill_file.read_text(encoding="utf-8")
        genome = cls.from_markdown(content)

        genome.referenced_files = cls._extract_referenced_paths(content)

        meta = cls._load_meta_file(path)
        if meta:
            genome.file_meta = meta

        exclude_dirs = {
            "snapshots",
            ".opt",
            ".git",
            "__pycache__",
            "node_modules",
            ".venv",
            "venv",
        }

        for item in path.rglob("*"):
            rel = item.relative_to(path)
            rel_parts = rel.parts
            if any((p in exclude_dirs) or p.startswith(".") for p in rel_parts):
                continue
            if (
                item.is_file()
                and item.name != "SKILL.md"
                and item.name != "AUXILIARY_META.json"
            ):
                rel_path = rel.as_posix()
                if not (rel_path.startswith("scripts/") or rel_path.startswith("references/")):
                    continue
                try:
                    genome.files[rel_path] = item.read_text(
                        encoding="utf-8", errors="ignore"
                    )
                except Exception:
                    continue

        return genome

    def hash(self) -> str:
        return hashlib.md5(self.to_markdown().encode("utf-8")).hexdigest()

    @staticmethod
    def _extract_name_from_frontmatter(text: str) -> str:
        match = re.match(r"^---\n(.*?)\n---", text, re.DOTALL)
        if not match:
            return ""
        fm = match.group(1)
        name_match = re.search(r"^name:\s*(.+)\s*$", fm, re.MULTILINE)
        if not name_match:
            return ""
        return name_match.group(1).strip().strip('"').strip("'")

    @staticmethod
    def _load_meta_file(path: Path) -> Dict[str, str]:
        candidates = [
            path / "AUXILIARY_META.json",
            path / ".opt" / "auxiliary_meta.json",
        ]
        for meta_path in candidates:
            if not meta_path.exists():
                continue
            try:
                data = json.loads(meta_path.read_text(encoding="utf-8"))
                if not isinstance(data, dict):
                    continue
                out: Dict[str, str] = {}
                for k, v in data.items():
                    if isinstance(v, str):
                        out[k] = v
                    elif isinstance(v, dict):
                        out[k] = str(v.get("summary", "") or "")
                    else:
                        out[k] = ""
                return out
            except Exception:
                continue
        return {}

    @staticmethod
    def _extract_referenced_paths(skill_content: str) -> set:
        if not skill_content:
            return set()
        matches = re.findall(r"\b(?:scripts|references)/[A-Za-z0-9._/\-]+\.[A-Za-z0-9]+\b", skill_content)
        return set(matches)
