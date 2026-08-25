"""Assemble fault UI presentation from skills/*/SKILL.md metadata."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Any

from ...pipeline.exceptions import ConfigurationError
from .capability_api import method_labels
from .definition import default_skills_root
from .models import FaultUiCatalog, FaultUiEntry, FaultUiSubmode
from .scenarios import parse_skill_submodes
from .skill_md import (
    metadata_dict,
    presentation_fields,
    read_frontmatter,
    title_from_skill,
)


def _parse_submode(raw: Any, *, fault_id: str, index: int) -> FaultUiSubmode:
    prefix = f"skills/{fault_id} metadata.submodes[{index}]"
    if not isinstance(raw, dict):
        raise ConfigurationError(f"{prefix} must be an object")
    submode_id: str | None = None
    if "id" in raw and raw.get("id") is not None:
        value = raw.get("id")
        if not isinstance(value, (str, int)) or not str(value).strip():
            raise ConfigurationError(f"{prefix}.id must be a non-empty string")
        submode_id = str(value).strip()
    name = raw.get("name")
    if not isinstance(name, str) or not name.strip():
        raise ConfigurationError(f"{prefix} requires a non-empty name")
    description = raw.get("description", "")
    if description is None:
        description = ""
    if not isinstance(description, str):
        raise ConfigurationError(f"{prefix}.description must be a string")
    if "visible" in raw:
        raise ConfigurationError(
            f"{prefix}.visible is not allowed; omit hidden submodes instead"
        )
    return FaultUiSubmode(
        id=submode_id,
        name=name.strip(),
        description=description.strip(),
        visible=True,
    )


def _entry_from_skill(directory: Path) -> FaultUiEntry:
    skill_file = directory / "SKILL.md"
    frontmatter = read_frontmatter(skill_file)
    metadata = metadata_dict(frontmatter)
    fields = presentation_fields(metadata, skill_file=skill_file)

    submodes: tuple[FaultUiSubmode, ...] | None = None
    if "submodes" in fields:
        parsed: list[FaultUiSubmode] = []
        seen: set[str] = set()
        for index, item in enumerate(fields["submodes"]):
            submode = _parse_submode(item, fault_id=directory.name, index=index)
            if submode.id is not None:
                if submode.id in seen:
                    raise ConfigurationError(
                        f"Duplicate submode id {submode.id!r} under fault "
                        f"{directory.name!r}"
                    )
                seen.add(submode.id)
            parsed.append(submode)
        submodes = tuple(parsed)

    return FaultUiEntry(
        id=directory.name,
        label_zh=fields.get("label_zh"),
        label_en=fields.get("label_en"),
        visible=True,
        order=fields.get("order"),
        submodes=submodes,
        platforms=None,
    )


def load_fault_ui_catalog(skills_root: Path | None = None) -> FaultUiCatalog:
    root = skills_root or default_skills_root()
    injection_methods = method_labels()

    faults: list[FaultUiEntry] = []
    if root.is_dir():
        for directory in sorted(root.iterdir()):
            if not directory.is_dir() or not (directory / "SKILL.md").is_file():
                continue
            faults.append(_entry_from_skill(directory))

    return FaultUiCatalog(
        injection_methods=injection_methods,
        faults=tuple(faults),
    )


@lru_cache(maxsize=1)
def get_fault_ui_catalog() -> FaultUiCatalog:
    return load_fault_ui_catalog()


def invalidate_fault_ui_catalog() -> None:
    get_fault_ui_catalog.cache_clear()


def resolve_fault_platforms(
    *,
    fault_id: str,
    catalog: FaultUiCatalog | None = None,
    default: tuple[str, ...] = ("opencode", "xiaoo"),
) -> list[str]:
    """Return platform ids this fault supports (always framework default)."""

    del fault_id, catalog  # per-fault platforms are not part of the skill contract
    return list(default)


def resolve_fault_labels(
    *,
    fault_id: str,
    skill_file: Path,
    catalog: FaultUiCatalog | None = None,
) -> tuple[str, str]:
    """Return (label_zh, label_en) for a discovered fault."""
    ui = catalog or get_fault_ui_catalog()
    entry = ui.entry(fault_id)
    label_en = (entry.label_en if entry and entry.label_en else None) or fault_id
    if entry and entry.label_zh:
        return entry.label_zh, label_en
    title = title_from_skill(skill_file)
    return title or fault_id, label_en


def resolve_fault_submodes(
    *,
    fault_id: str,
    skill_file: Path,
    catalog: FaultUiCatalog | None = None,
) -> list[dict[str, str]]:
    """Return submodes for UI / run selection.

    Prefer explicit metadata.submodes when present; otherwise parse SKILL.md.
    Entries may omit ``id`` — then the id is taken from the same-index
    SKILL.md scenario (or ``1``/``2``/… as a last resort).
    """
    ui = catalog or get_fault_ui_catalog()
    entry = ui.entry(fault_id)
    if entry is None or entry.submodes is None:
        return parse_skill_submodes(skill_file)

    skill_subs = parse_skill_submodes(skill_file)
    resolved: list[dict[str, str]] = []
    for index, item in enumerate(entry.submodes):
        if not item.visible:
            continue
        skill = skill_subs[index] if index < len(skill_subs) else None
        submode_id = item.id or (skill["id"] if skill else str(index + 1))
        description = item.description
        if not description and skill is not None:
            description = skill.get("description", "")
        resolved.append(
            {
                "id": submode_id,
                "name": item.name,
                "description": description,
            }
        )
    return resolved


def injection_method_label(
    method: str,
    catalog: FaultUiCatalog | None = None,
) -> str:
    if catalog is not None:
        return catalog.injection_methods.get(method, method)
    return method_labels().get(method, method)
