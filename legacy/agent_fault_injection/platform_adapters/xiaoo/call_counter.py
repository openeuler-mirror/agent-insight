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

"""Durable per-tool call index for cross-process xiaoO hooks."""

from __future__ import annotations

import json
from pathlib import Path


def next_tool_call_index(counts_file: Path, tool: str) -> int:
    """Bump a durable per-tool call counter (1-based).

    xiaoO invokes the hooker as a fresh process per hook, so counters must
    live on disk under the run's raw/artifacts directory.
    """

    counts_file.parent.mkdir(parents=True, exist_ok=True)
    counts: dict[str, int] = {}
    if counts_file.is_file():
        try:
            loaded = json.loads(counts_file.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                for key, value in loaded.items():
                    if isinstance(value, int) and not isinstance(value, bool):
                        counts[str(key)] = value
        except (OSError, json.JSONDecodeError, TypeError, ValueError):
            counts = {}
    index = int(counts.get(tool, 0)) + 1
    counts[tool] = index
    counts_file.write_text(
        json.dumps(counts, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return index
