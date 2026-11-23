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

from __future__ import annotations

from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]


def test_downloaded_collector_layout_is_self_contained() -> None:
    assert (
        PROJECT_ROOT
        / "src"
        / "agent_insight_llamaindex"
        / "_bootstrap"
        / "sitecustomize.py"
    ).is_file()
    project_config = (PROJECT_ROOT / "pyproject.toml").read_text(encoding="utf-8")
    assert "[build-system]" not in project_config
    assert "[project]" not in project_config
    assert not (PROJECT_ROOT / "install.py").exists()
    assert not (PROJECT_ROOT / "bootstrap" / "sitecustomize.py").exists()
