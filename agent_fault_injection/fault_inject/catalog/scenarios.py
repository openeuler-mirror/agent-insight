"""Parse fault skill scenarios (submodes) from SKILL.md."""

from __future__ import annotations

import re
from pathlib import Path

_HEADING_RE = re.compile(
    r"^##\s*场景\s*([0-9A-Za-z]+)[：:,，]\s*(.+?)\s*$"
)
_TABLE_ROW_RE = re.compile(r"^\|\s*(.+?)\s*\|")
_SCENE_ID_RE = re.compile(r"^[0-9]+$|^[A-Za-z]$")


def _strip_cell(value: str) -> str:
    text = value.strip()
    text = text.strip("`").strip()
    text = re.sub(r"\*+", "", text).strip()
    return text


def _split_row(line: str) -> list[str]:
    raw = line.strip().strip("|")
    return [_strip_cell(cell) for cell in raw.split("|")]


def _is_separator_row(cells: list[str]) -> bool:
    if not cells:
        return False
    return all(re.fullmatch(r":?-{3,}:?", cell or "") is not None for cell in cells)


def _parse_overview_table(lines: list[str]) -> list[dict[str, str]]:
    """Parse the first markdown table whose first column looks like scene ids."""

    index = 0
    while index < len(lines):
        line = lines[index]
        if not line.strip().startswith("|"):
            index += 1
            continue

        block: list[str] = []
        while index < len(lines) and lines[index].strip().startswith("|"):
            block.append(lines[index])
            index += 1
        if len(block) < 2:
            continue

        header = _split_row(block[0])
        body_start = 1
        if body_start < len(block) and _is_separator_row(_split_row(block[body_start])):
            body_start += 1

        rows: list[dict[str, str]] = []
        for row_line in block[body_start:]:
            cells = _split_row(row_line)
            if not cells or _is_separator_row(cells):
                continue
            scene_id = cells[0]
            if not _SCENE_ID_RE.fullmatch(scene_id):
                rows = []
                break
            name = cells[1] if len(cells) > 1 else f"场景{scene_id}"
            description = ""
            if len(cells) >= 5:
                description = cells[4] if cells[4] else cells[3]
            elif len(cells) >= 4:
                description = cells[3]
            elif len(cells) >= 3:
                description = cells[2]
            rows.append(
                {
                    "id": scene_id,
                    "name": name or f"场景{scene_id}",
                    "description": description,
                }
            )
        if rows:
            return rows
    return []


def _parse_headings(lines: list[str]) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    seen: set[str] = set()
    for line in lines:
        match = _HEADING_RE.match(line.strip())
        if not match:
            continue
        scene_id = match.group(1)
        if scene_id in seen:
            continue
        seen.add(scene_id)
        name = _strip_cell(match.group(2))
        # Drop trailing detector suffixes like "— xxx" for shorter labels.
        name = re.split(r"\s+[—–-]\s+", name, maxsplit=1)[0].strip() or name
        rows.append(
            {
                "id": scene_id,
                "name": name or f"场景{scene_id}",
                "description": "",
            }
        )
    return rows


def parse_skill_submodes(skill_file: Path) -> list[dict[str, str]]:
    """Return ordered submodes for a fault skill.

    Prefers the overview markdown table (场景总览 / 检测场景总览). Falls back to
    ``## 场景N：…`` headings when no suitable table exists.
    """

    try:
        content = skill_file.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return []

    lines = content.splitlines()
    from_table = _parse_overview_table(lines)
    if from_table:
        return from_table
    return _parse_headings(lines)


def normalize_submode(value: str | None) -> str | None:
    """Normalize UI/CLI submode labels to a comparable id.

    Accepts ``"1"``, ``"场景1"``, ``"case1"`` style by extracting digits when
    present; otherwise returns the stripped text. Used by structural and
    runtime injection filters so both layers agree on the active submode.
    """

    if value is None:
        return None
    text = value.strip()
    if not text:
        return None
    digits = "".join(ch for ch in text if ch.isdigit())
    if digits:
        return digits.lstrip("0") or "0"
    return text
