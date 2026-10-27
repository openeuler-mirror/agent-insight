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

import json
import re
import shutil
from datetime import datetime
from pathlib import Path
from typing import Optional, List

class SnapshotManager:
    def __init__(self, skill_dir: Path, snapshots_dir: Optional[Path] = None):
        self.skill_dir = skill_dir.resolve()
        self.snapshots_dir = (snapshots_dir.resolve() if snapshots_dir else self.skill_dir / "snapshots")

    def _parse_version(self, version_str: str) -> tuple[int, int]:
        """Parse version string like 'v1' or 'v1.2' into (major, minor)."""
        match = re.match(r'^v(\d+)(?:\.(\d+))?$', version_str)
        if not match:
            return -1, -1
        major = int(match.group(1))
        minor = int(match.group(2)) if match.group(2) else 0
        return major, minor

    def get_latest_version(self) -> Optional[str]:
        """Get the latest version directory name."""
        if not self.snapshots_dir.exists():
            return None
        
        versions = []
        for d in self.snapshots_dir.iterdir():
            if d.is_dir() and d.name.startswith('v'):
                major, minor = self._parse_version(d.name)
                if major >= 0:
                    versions.append((major, minor, d.name))
        
        if not versions:
            return None
        
        versions.sort(key=lambda x: (x[0], x[1]))
        return versions[-1][2]

    def get_latest_base_version(self) -> Optional[str]:
        """Get the latest base version (minor == 0)."""
        if not self.snapshots_dir.exists():
            return None
        
        versions = []
        for d in self.snapshots_dir.iterdir():
            if d.is_dir() and d.name.startswith('v'):
                major, minor = self._parse_version(d.name)
                if major >= 0 and minor == 0:
                    versions.append((major, minor, d.name))
        
        if not versions:
            return None
        
        versions.sort(key=lambda x: x[0])
        return versions[-1][2]

    def get_current_base_version(self) -> Optional[str]:
        """Get the version currently active in the workspace."""
        path = self.skill_dir / ".opt" / "current_base_version"
        if path.exists():
            return path.read_text(encoding="utf-8").strip()
        return self.get_latest_base_version()

    def set_current_base_version(self, version_str: str) -> None:
        """Set the version currently active in the workspace."""
        opt_dir = self.skill_dir / ".opt"
        opt_dir.mkdir(parents=True, exist_ok=True)
        path = opt_dir / "current_base_version"
        path.write_text(version_str, encoding="utf-8")

    def _copy_skill_files(self, dest_dir: Path, exclude_dirs: List[str] = None):
        """Copy skill files to destination, excluding specific directories."""
        if exclude_dirs is None:
            exclude_dirs = ['snapshots', '.git', '__pycache__', 'node_modules', '.venv', 'venv', '.opt']
            
        dest_dir.mkdir(parents=True, exist_ok=True)
        for item in self.skill_dir.iterdir():
            if item.name in exclude_dirs:
                continue
            if item.is_dir():
                shutil.copytree(item, dest_dir / item.name, dirs_exist_ok=True)
            else:
                shutil.copy2(item, dest_dir / item.name)

    def create_v0_if_needed(self) -> str:
        """Create v0 snapshot if snapshots directory doesn't exist."""
        if not self.snapshots_dir.exists() or not (self.snapshots_dir / "v0").exists():
            v0_dir = self.snapshots_dir / "v0"
            self._copy_skill_files(v0_dir)
            
            meta = {
                "reason": "Initial version",
                "source": "auto",
                "mode": "init",
                "created_at": datetime.utcnow().isoformat() + "Z",
                "base_version": None,
                "notes": []
            }
            with open(v0_dir / "meta.json", "w", encoding="utf-8") as f:
                json.dump(meta, f, indent=2, ensure_ascii=False)
            self.set_current_base_version("v0")
            return "v0"
            
        curr = self.get_current_base_version()
        if not curr:
            latest = self.get_latest_base_version()
            if latest:
                self.set_current_base_version(latest)
            return latest or "v0"
        return curr

    def create_snapshot(self, mode: str, reason: str, source: str, is_feedback: bool = False) -> str:
        """Create a new snapshot directory and write meta.json.

        For v0 baseline, use create_v0_if_needed() which copies current files.
        For other snapshots, caller writes the optimized artifacts into the snapshot directory.
        """
        self.create_v0_if_needed()
        
        current_base = self.get_current_base_version() or "v0"
        base_major, base_minor = self._parse_version(current_base)
        
        if is_feedback:
            # Feedback conceptually bumps the minor version of its base
            max_minor = base_minor
            for d in self.snapshots_dir.iterdir():
                if d.is_dir() and d.name.startswith(f"v{base_major}."):
                    _, mi = self._parse_version(d.name)
                    if mi > max_minor:
                        max_minor = mi
            new_version = f"v{base_major}.{max_minor + 1}"
            base_version = current_base
        else:
            # Major optimization creates a NEW major version branch
            highest_major = 0
            for d in self.snapshots_dir.iterdir():
                if d.is_dir() and d.name.startswith("v"):
                    maj, _ = self._parse_version(d.name)
                    if maj > highest_major:
                        highest_major = maj
            new_version = f"v{highest_major + 1}"
            base_version = current_base

        new_dir = self.snapshots_dir / new_version
        if new_dir.exists():
            shutil.rmtree(new_dir)
        new_dir.mkdir(parents=True, exist_ok=True)
        self._copy_skill_files(new_dir)
        
        meta = {
            "reason": reason,
            "source": source,
            "mode": mode,
            "created_at": datetime.utcnow().isoformat() + "Z",
            "base_version": base_version,
            "notes": []
        }
        with open(new_dir / "meta.json", "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=2, ensure_ascii=False)
            
        self.set_current_base_version(new_version)
        return new_version
        
    def accept_latest(self) -> Optional[str]:
        """Accept the latest candidate and make it a new base version."""
        current = self.get_current_base_version()
        if not current:
            current = self.get_latest_version()
        if not current:
            return None
            
        major, minor = self._parse_version(current)
        if minor == 0:
            return current # Already a base version
            
        highest_major = 0
        for d in self.snapshots_dir.iterdir():
            if d.is_dir() and d.name.startswith("v"):
                maj, _ = self._parse_version(d.name)
                if maj > highest_major:
                    highest_major = maj
                    
        new_version = f"v{highest_major + 1}"
        new_dir = self.snapshots_dir / new_version
        
        # Copy from current version to new major version
        current_dir = self.snapshots_dir / current
        if new_dir.exists():
            shutil.rmtree(new_dir)
        shutil.copytree(current_dir, new_dir, dirs_exist_ok=True)
        
        # Update meta.json
        meta_path = new_dir / "meta.json"

        meta = {
            "reason": "用户接受: Accept",
            "source": "user",
            "mode": "accept",
            "created_at": datetime.utcnow().isoformat() + "Z",
            "base_version": current,
            "notes": []
        }
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=2, ensure_ascii=False)
                
        self.set_current_base_version(new_version)
        return new_version

    def revert_to(self, target_version: str) -> bool:
        """Revert the skill directory to the state of the target version."""
        target_dir = self.snapshots_dir / target_version
        if not target_dir.exists():
            return False

        _skip_on_revert = {
            'meta.json', 'diagnoses.json', 'OPTIMIZATION_REPORT.md',
            'AUXILIARY_META.json',
        }
            
        # Clear current skill dir contents except snapshots and hidden dirs
        for item in self.skill_dir.iterdir():
            if item.name in ['snapshots', '.git', '.venv', 'venv', '.opt'] or item.name.startswith('.'):
                continue
            if item.is_dir():
                shutil.rmtree(item)
            else:
                item.unlink()
                
        # Copy target version contents back (excluding process artifacts)
        for item in target_dir.iterdir():
            if item.name in _skip_on_revert:
                continue
            if item.is_dir():
                shutil.copytree(item, self.skill_dir / item.name, dirs_exist_ok=True)
            else:
                shutil.copy2(item, self.skill_dir / item.name)
                
        self.set_current_base_version(target_version)
        return True
