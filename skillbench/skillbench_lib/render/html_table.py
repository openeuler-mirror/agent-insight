"""HTML rendering helpers shared by SkillBench table reports."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from html import escape
from pathlib import Path
from string import Template


@dataclass(frozen=True)
class TableCell:
    text: str
    style: Mapping[str, str] = field(default_factory=dict)
    header: bool = False
    class_name: str | None = None
    colspan: int = 1
    rowspan: int = 1


@dataclass(frozen=True)
class Table:
    headers: Sequence[str]
    rows: Sequence[Sequence[str | TableCell]]
    header_rows: Sequence[Sequence[str | TableCell]] | None = None
    caption: str | None = None
    class_name: str = "data-table"


def _style_attr(style: Mapping[str, str]) -> str:
    if not style:
        return ""
    return ' style="' + "; ".join(f"{key}: {value}" for key, value in style.items()) + '"'


def _class_attr(class_name: str | None) -> str:
    return f' class="{escape(class_name, quote=True)}"' if class_name else ""


def _span_attrs(cell: TableCell) -> str:
    attrs = []
    if cell.colspan > 1:
        attrs.append(f'colspan="{cell.colspan}"')
    if cell.rowspan > 1:
        attrs.append(f'rowspan="{cell.rowspan}"')
    return (" " + " ".join(attrs)) if attrs else ""


def _html_cell(cell: str | TableCell, *, header: bool = False) -> str:
    if isinstance(cell, str):
        tag = "th" if header else "td"
        return f"<{tag}>{escape(cell)}</{tag}>"
    tag = "th" if cell.header or header else "td"
    return (
        f"<{tag}{_class_attr(cell.class_name)}{_style_attr(cell.style)}{_span_attrs(cell)}>"
        f"{escape(cell.text)}"
        f"</{tag}>"
    )


def render_table_html(table: Table) -> str:
    caption_html = f"<caption>{escape(table.caption)}</caption>" if table.caption else ""
    if table.header_rows is None:
        header_html = "<tr>" + "".join(f"<th>{escape(header)}</th>" for header in table.headers) + "</tr>"
    else:
        header_html = "".join(
            "<tr>" + "".join(_html_cell(cell, header=True) for cell in row) + "</tr>"
            for row in table.header_rows
        )
    body_html = "".join("<tr>" + "".join(_html_cell(cell) for cell in row) + "</tr>" for row in table.rows)
    return (
        f'<table class="{escape(table.class_name, quote=True)}">'
        f"{caption_html}"
        f"<thead>{header_html}</thead>"
        f"<tbody>{body_html}</tbody>"
        "</table>"
    )


def render_table_markdown(table: Table) -> str:
    separator = ["---"] * len(table.headers)
    lines = [
        "| " + " | ".join(table.headers) + " |",
        "| " + " | ".join(separator) + " |",
    ]
    for row in table.rows:
        values = [cell.text if isinstance(cell, TableCell) else str(cell) for cell in row]
        lines.append("| " + " | ".join(values) + " |")
    return "\n".join(lines) + "\n"


def render_template(name: str, **values: str) -> str:
    path = Path(__file__).with_name("templates") / name
    return Template(path.read_text(encoding="utf-8")).safe_substitute(values)
