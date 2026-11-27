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

"""Markdown rendering helpers shared by SkillBench reports."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any, Protocol


class TableLike(Protocol):
    columns: Sequence[str]
    index: Sequence[str]

    @property
    def loc(self) -> Any: ...


def render_markdown_table(headers: Sequence[str], rows: Sequence[Sequence[str]]) -> str:
    separator = ["---"] * len(headers)
    lines = [
        "| " + " | ".join(headers) + " |",
        "| " + " | ".join(separator) + " |",
    ]
    lines.extend("| " + " | ".join(row) + " |" for row in rows)
    return "\n".join(lines)


def render_dataframe_markdown_table(df: TableLike, index_header: str = "task") -> str:
    headers = [index_header, *list(df.columns)]
    rows = [
        [str(index_value), *[str(df.loc[index_value, column]) for column in df.columns]]
        for index_value in df.index
    ]
    return render_markdown_table(headers, rows) + "\n"
