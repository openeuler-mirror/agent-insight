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

import tempfile
from pathlib import Path
from unittest import TestCase

from agent_fault_injection.pipeline.exceptions import InstallationConflictError
from agent_fault_injection.fault_inject.injection.installer import InstallSession


class InstallSessionTests(TestCase):
    def test_installs_and_removes_only_managed_paths(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.txt"
            source.write_text("fault", encoding="utf-8")
            target = root / "project" / ".opencode" / "skills" / "fault" / "SKILL.md"
            user_file = root / "project" / "keep.txt"
            user_file.parent.mkdir()
            user_file.write_text("keep", encoding="utf-8")

            session = InstallSession()
            session.install_file(source, target)

            self.assertEqual(target.read_text(encoding="utf-8"), "fault")
            session.cleanup()

            self.assertFalse(target.exists())
            self.assertTrue(user_file.exists())

    def test_refuses_to_overwrite_existing_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.txt"
            target = root / "target.txt"
            source.write_text("new", encoding="utf-8")
            target.write_text("user", encoding="utf-8")

            with self.assertRaises(InstallationConflictError):
                InstallSession().install_file(source, target)

            self.assertEqual(target.read_text(encoding="utf-8"), "user")

    def test_overwrite_replaces_existing_managed_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.txt"
            target = root / "project" / ".opencode" / "plugins" / "agent-fault-injection.ts"
            source.write_text("new-plugin", encoding="utf-8")
            target.parent.mkdir(parents=True)
            target.write_text("stale-plugin", encoding="utf-8")

            session = InstallSession()
            session.install_file(source, target, overwrite=True)

            self.assertEqual(target.read_text(encoding="utf-8"), "new-plugin")
            session.cleanup()
            self.assertEqual(target.read_text(encoding="utf-8"), "stale-plugin")

    def test_overwrite_cleanup_restores_preexisting_user_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.txt"
            target = root / "project" / ".opencode" / "skills" / "fault" / "SKILL.md"
            source.write_text("injected", encoding="utf-8")
            target.parent.mkdir(parents=True)
            target.write_text("user-skill", encoding="utf-8")

            session = InstallSession()
            session.install_file(source, target, overwrite=True)

            self.assertEqual(target.read_text(encoding="utf-8"), "injected")
            session.cleanup()
            self.assertEqual(target.read_text(encoding="utf-8"), "user-skill")

