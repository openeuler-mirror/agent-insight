"""SKILL.md frontmatter read/write — single source for definition + presentation."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

from ...pipeline.exceptions import ConfigurationError

_FORBIDDEN_METADATA_KEYS = frozenset({"visible", "platforms", "ui"})
_PRESENTATION_KEYS = frozenset({"label_zh", "label_en", "order", "submodes"})


def read_frontmatter(skill_file: Path) -> dict[str, Any]:
    try:
        content = skill_file.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        raise ConfigurationError(f"Cannot read fault skill {skill_file}: {exc}") from exc

    lines = content.splitlines()
    if not lines or lines[0].strip() != "---":
        raise ConfigurationError(
            f"Fault skill must start with YAML frontmatter: {skill_file}"
        )
    try:
        closing = next(
            index for index, line in enumerate(lines[1:], start=1)
            if line.strip() == "---"
        )
    except StopIteration as exc:
        raise ConfigurationError(
            f"Fault skill has unterminated YAML frontmatter: {skill_file}"
        ) from exc

    try:
        value = yaml.safe_load("\n".join(lines[1:closing]))
    except yaml.YAMLError as exc:
        raise ConfigurationError(
            f"Fault skill has invalid YAML frontmatter: {skill_file}: {exc}"
        ) from exc
    if not isinstance(value, dict):
        raise ConfigurationError(
            f"Fault skill frontmatter must be an object: {skill_file}"
        )
    for field in ("name", "description"):
        if not isinstance(value.get(field), str) or not value[field].strip():
            raise ConfigurationError(
                f"Fault skill frontmatter requires a non-empty {field!r}: "
                f"{skill_file}"
            )
    metadata = value.get("metadata")
    if metadata is not None:
        if not isinstance(metadata, dict):
            raise ConfigurationError(
                f"Fault skill metadata must be an object: {skill_file}"
            )
        banned = _FORBIDDEN_METADATA_KEYS.intersection(metadata)
        if banned:
            raise ConfigurationError(
                f"Fault skill metadata must not define {sorted(banned)}: "
                f"{skill_file}"
            )
    return value


def write_frontmatter(skill_file: Path, frontmatter: dict[str, Any]) -> None:
    content = skill_file.read_text(encoding="utf-8")
    lines = content.splitlines(keepends=True)
    if not lines or lines[0].strip() != "---":
        raise ConfigurationError(
            f"Fault skill must start with YAML frontmatter: {skill_file}"
        )
    closing = next(
        index for index, line in enumerate(lines[1:], start=1)
        if line.strip() == "---"
    )
    dumped = yaml.safe_dump(
        frontmatter,
        allow_unicode=True,
        sort_keys=False,
        default_flow_style=False,
    )
    skill_file.write_text(
        f"---\n{dumped}---\n{''.join(lines[closing + 1:])}",
        encoding="utf-8",
    )


def rewrite_frontmatter_description(skill_file: Path, description: str) -> None:
    frontmatter = read_frontmatter(skill_file)
    frontmatter["description"] = description
    write_frontmatter(skill_file, frontmatter)


def title_from_skill(skill_file: Path) -> str | None:
    try:
        for line in skill_file.read_text(encoding="utf-8").splitlines():
            if line.startswith("# "):
                title = line[2:].strip()
                if title:
                    return title
    except OSError:
        return None
    return None


def metadata_dict(frontmatter: dict[str, Any]) -> dict[str, Any]:
    metadata = frontmatter.get("metadata")
    return metadata if isinstance(metadata, dict) else {}


def presentation_fields(
    metadata: dict[str, Any],
    *,
    skill_file: Path,
) -> dict[str, Any]:
    """Return validated presentation keys from metadata (may be empty)."""

    result: dict[str, Any] = {}
    for key in _PRESENTATION_KEYS:
        if key not in metadata:
            continue
        result[key] = metadata[key]

    if "label_zh" in result:
        label_zh = result["label_zh"]
        if not isinstance(label_zh, str) or not label_zh.strip():
            raise ConfigurationError(
                f"metadata.label_zh must be a non-empty string: {skill_file}"
            )
        result["label_zh"] = label_zh.strip()

    if "label_en" in result:
        label_en = result["label_en"]
        if not isinstance(label_en, str) or not label_en.strip():
            raise ConfigurationError(
                f"metadata.label_en must be a non-empty string: {skill_file}"
            )
        result["label_en"] = label_en.strip()

    if "order" in result:
        order = result["order"]
        if isinstance(order, bool) or not isinstance(order, (int, float)):
            raise ConfigurationError(
                f"metadata.order must be a number: {skill_file}"
            )
        result["order"] = int(order)

    if "submodes" in result:
        submodes = result["submodes"]
        if submodes is None or submodes == []:
            result.pop("submodes")
        elif not isinstance(submodes, list):
            raise ConfigurationError(
                f"metadata.submodes must be a list: {skill_file}"
            )

    return result
