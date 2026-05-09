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
