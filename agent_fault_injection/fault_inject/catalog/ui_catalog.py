"""Load fault UI presentation metadata from fault-catalog.yaml."""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml

from ...pipeline.exceptions import ConfigurationError
from .scenarios import parse_skill_submodes


@dataclass(frozen=True, slots=True)
class FaultUiSubmode:
    name: str
    id: str | None = None
    description: str = ""
    visible: bool = True

    def as_dict(self) -> dict[str, str]:
        return {
            "id": self.id or "",
            "name": self.name,
            "description": self.description,
        }


@dataclass(frozen=True, slots=True)
class FaultUiEntry:
    id: str
    label_zh: str | None = None
    label_en: str | None = None
    visible: bool = True
    submodes: tuple[FaultUiSubmode, ...] | None = None
    platforms: tuple[str, ...] | None = None


@dataclass(frozen=True, slots=True)
class FaultUiCatalog:
    injection_methods: dict[str, str]
    faults: tuple[FaultUiEntry, ...]

    def entry(self, fault_id: str) -> FaultUiEntry | None:
        for item in self.faults:
            if item.id == fault_id:
                return item
        return None

    def ordered_ids(self, discovered: list[str]) -> list[str]:
        """Return discovered ids ordered by catalog, then remaining sorted."""
        discovered_set = set(discovered)
        hidden = {item.id for item in self.faults if not item.visible}
        ordered = [
            item.id
            for item in self.faults
            if item.visible and item.id in discovered_set
        ]
        known = {item.id for item in self.faults}
        remaining = sorted(
            name for name in discovered if name not in known and name not in hidden
        )
        return ordered + remaining


def default_catalog_path() -> Path:
    return Path(__file__).resolve().parent / "fault-catalog.yaml"


def _title_from_skill(skill_file: Path) -> str | None:
    try:
        for line in skill_file.read_text(encoding="utf-8").splitlines():
            if line.startswith("# "):
                title = line[2:].strip()
                if title:
                    return title
    except OSError:
        return None
    return None


def _parse_submode(raw: Any, *, fault_index: int, index: int) -> FaultUiSubmode:
    prefix = f"fault-catalog.yaml faults[{fault_index}].submodes[{index}]"
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
    visible = raw.get("visible", True)
    if not isinstance(visible, bool):
        raise ConfigurationError(f"{prefix}.visible must be a boolean")
    return FaultUiSubmode(
        id=submode_id,
        name=name.strip(),
        description=description.strip(),
        visible=visible,
    )


def _parse_entry(raw: Any, *, index: int) -> FaultUiEntry:
    if not isinstance(raw, dict):
        raise ConfigurationError(
            f"fault-catalog.yaml faults[{index}] must be an object"
        )
    fault_id = raw.get("id")
    if not isinstance(fault_id, str) or not fault_id.strip():
        raise ConfigurationError(
            f"fault-catalog.yaml faults[{index}] requires a non-empty id"
        )
    label_zh = raw.get("label_zh")
    label_en = raw.get("label_en")
    visible = raw.get("visible", True)
    if label_zh is not None and (
        not isinstance(label_zh, str) or not label_zh.strip()
    ):
        raise ConfigurationError(
            f"fault-catalog.yaml faults[{index}].label_zh must be a non-empty string"
        )
    if label_en is not None and (
        not isinstance(label_en, str) or not label_en.strip()
    ):
        raise ConfigurationError(
            f"fault-catalog.yaml faults[{index}].label_en must be a non-empty string"
        )
    if not isinstance(visible, bool):
        raise ConfigurationError(
            f"fault-catalog.yaml faults[{index}].visible must be a boolean"
        )

    submodes: tuple[FaultUiSubmode, ...] | None = None
    if "submodes" in raw:
        submodes_raw = raw.get("submodes")
        if submodes_raw is None:
            submodes = None
        elif not isinstance(submodes_raw, list):
            raise ConfigurationError(
                f"fault-catalog.yaml faults[{index}].submodes must be a list"
            )
        elif not submodes_raw:
            # Empty list == omit; fall back to SKILL.md parsing.
            submodes = None
        else:
            parsed: list[FaultUiSubmode] = []
            seen: set[str] = set()
            for sub_index, item in enumerate(submodes_raw):
                submode = _parse_submode(
                    item, fault_index=index, index=sub_index
                )
                if submode.id is not None:
                    if submode.id in seen:
                        raise ConfigurationError(
                            f"Duplicate submode id {submode.id!r} under fault "
                            f"{fault_id.strip()!r}"
                        )
                    seen.add(submode.id)
                parsed.append(submode)
            submodes = tuple(parsed)

    platforms: tuple[str, ...] | None = None
    if "platforms" in raw and raw.get("platforms") is not None:
        platforms_raw = raw.get("platforms")
        if not isinstance(platforms_raw, list) or not platforms_raw:
            raise ConfigurationError(
                f"fault-catalog.yaml faults[{index}].platforms must be a "
                "non-empty list of platform ids"
            )
        parsed_platforms: list[str] = []
        for item in platforms_raw:
            if not isinstance(item, str) or not item.strip():
                raise ConfigurationError(
                    f"fault-catalog.yaml faults[{index}].platforms entries "
                    "must be non-empty strings"
                )
            parsed_platforms.append(item.strip().lower())
        platforms = tuple(parsed_platforms)

    return FaultUiEntry(
        id=fault_id.strip(),
        label_zh=label_zh.strip() if isinstance(label_zh, str) else None,
        label_en=label_en.strip() if isinstance(label_en, str) else None,
        visible=visible,
        submodes=submodes,
        platforms=platforms,
    )


def load_fault_ui_catalog(path: Path | None = None) -> FaultUiCatalog:
    catalog_path = path or default_catalog_path()
    if not catalog_path.is_file():
        return FaultUiCatalog(
            injection_methods={"skill_inject": "Skill 注入"}, faults=()
        )

    try:
        raw = yaml.safe_load(catalog_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, yaml.YAMLError) as exc:
        raise ConfigurationError(
            f"Cannot read fault UI catalog {catalog_path}: {exc}"
        ) from exc

    if raw is None:
        return FaultUiCatalog(
            injection_methods={"skill_inject": "Skill 注入"}, faults=()
        )
    if not isinstance(raw, dict):
        raise ConfigurationError(
            f"Fault UI catalog must be a mapping: {catalog_path}"
        )

    methods_raw = raw.get("injection_methods") or {}
    if not isinstance(methods_raw, dict):
        raise ConfigurationError(
            f"fault-catalog.yaml injection_methods must be a mapping: {catalog_path}"
        )
    injection_methods: dict[str, str] = {}
    for key, value in methods_raw.items():
        if not isinstance(key, str) or not isinstance(value, str) or not value.strip():
            raise ConfigurationError(
                "fault-catalog.yaml injection_methods values must be non-empty strings"
            )
        injection_methods[key] = value.strip()
    if "skill_inject" not in injection_methods:
        injection_methods["skill_inject"] = "Skill 注入"

    faults_raw = raw.get("faults") or []
    if not isinstance(faults_raw, list):
        raise ConfigurationError(
            f"fault-catalog.yaml faults must be a list: {catalog_path}"
        )
    faults: list[FaultUiEntry] = []
    seen: set[str] = set()
    for index, item in enumerate(faults_raw):
        entry = _parse_entry(item, index=index)
        if entry.id in seen:
            raise ConfigurationError(
                f"Duplicate fault id in fault-catalog.yaml: {entry.id}"
            )
        seen.add(entry.id)
        faults.append(entry)

    return FaultUiCatalog(
        injection_methods=injection_methods,
        faults=tuple(faults),
    )


@lru_cache(maxsize=1)
def get_fault_ui_catalog() -> FaultUiCatalog:
    return load_fault_ui_catalog()


def resolve_fault_platforms(
    *,
    fault_id: str,
    catalog: FaultUiCatalog | None = None,
    default: tuple[str, ...] = ("opencode", "xiaoo"),
) -> list[str]:
    """Return platform ids this fault supports (catalog override or default)."""

    ui = catalog or get_fault_ui_catalog()
    entry = ui.entry(fault_id)
    if entry and entry.platforms:
        return list(entry.platforms)
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
    title = _title_from_skill(skill_file)
    return title or fault_id, label_en


def resolve_fault_submodes(
    *,
    fault_id: str,
    skill_file: Path,
    catalog: FaultUiCatalog | None = None,
) -> list[dict[str, str]]:
    """Return submodes for UI / run selection.

    Prefer explicit catalog submodes when present; otherwise parse SKILL.md.
    Catalog entries may omit ``id`` — then the id is taken from the same-index
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
    ui = catalog or get_fault_ui_catalog()
    return ui.injection_methods.get(method, method)
