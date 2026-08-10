"""Load fault definitions and discover built-in skill catalogs."""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from typing import Any

from ...pipeline.exceptions import (
    ConfigurationError,
    FaultNotFoundError,
    InstallationConflictError,
)
from .models import FaultDefinition, InjectionStep
from .skill_md import (
    metadata_dict,
    read_frontmatter,
    write_frontmatter,
)

_FAULT_NAME = re.compile(r"^[a-z0-9]+(?:[-_][a-z0-9]+)*$")
_MANIFEST_NAME = "fault.json"
_TOOL_REFERENCE = re.compile(r"^\{tool:([^{}]+)\}$")


def default_skills_root() -> Path:
    # skills/ lives under fault_inject/, sibling of catalog/
    return Path(__file__).resolve().parent.parent / "skills"


def _validate_fault_name(name: str) -> str:
    normalized = name.strip()
    if not _FAULT_NAME.fullmatch(normalized):
        raise ConfigurationError(
            "Fault name must use lowercase letters, digits, and single "
            "hyphens or underscores as separators"
        )
    return normalized


def _infer_method_from_runtime(
    steps: tuple[InjectionStep, ...],
) -> str | None:
    kinds: set[str] = set()
    for step in steps:
        op = step.op
        if op.startswith("tool_result."):
            kinds.add("tool_result_tamper")
        elif op.startswith("system.") or op.startswith("user."):
            kinds.add("prompt_modify")
        elif op.startswith("messages.") or op.startswith("assistant."):
            kinds.add("intercept_rewrite")
    if len(kinds) == 1:
        return next(iter(kinds))
    if not kinds:
        return None
    # Mixed runtime ops require an explicit injection_method in fault.json.
    return None


def load_fault_definition(directory: Path) -> FaultDefinition:
    skill_file = directory / "SKILL.md"
    frontmatter = read_frontmatter(skill_file)
    manifest_file = directory / _MANIFEST_NAME

    if manifest_file.is_file():
        try:
            manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise ConfigurationError(
                f"Cannot read fault manifest {manifest_file}: {exc}"
            ) from exc
        if not isinstance(manifest, dict):
            raise ConfigurationError(
                f"Fault manifest must be an object: {manifest_file}"
            )
    else:
        metadata = metadata_dict(frontmatter)
        manifest = {
            "name": directory.name,
            "skill_name": frontmatter["name"],
            "category": (
                metadata.get("fault-category")
                or frontmatter.get("category")
                or "behavioral"
            ),
            "description": frontmatter["description"],
        }

    name = _validate_fault_name(str(manifest.get("name", "")))
    if name != directory.name:
        raise ConfigurationError(
            f"Fault manifest name {name!r} does not match directory "
            f"{directory.name!r}"
        )

    # Prefer SKILL.md frontmatter description over fault.json placeholders.
    frontmatter_description = frontmatter.get("description")
    if isinstance(frontmatter_description, str) and frontmatter_description.strip():
        manifest["description"] = frontmatter_description.strip()

    values: dict[str, str] = {}
    for field in ("skill_name", "category", "description"):
        value = manifest.get(field)
        if not isinstance(value, str) or not value.strip():
            raise ConfigurationError(
                f"Fault manifest requires a non-empty {field!r}: {manifest_file}"
            )
        values[field] = value.strip()

    if values["skill_name"] != frontmatter["name"].strip():
        raise ConfigurationError(
            f"Fault manifest skill_name does not match SKILL.md: {manifest_file}"
        )

    raw_tools = manifest.get("tools", [])
    if not isinstance(raw_tools, list):
        raise ConfigurationError(
            f"Fault manifest tools must be a list: {manifest_file}"
        )

    tool_names: list[str] = []
    tool_files: list[Path] = []
    tools_directory = directory / "scripts"
    for raw_tool in raw_tools:
        if not isinstance(raw_tool, str) or not raw_tool.strip():
            raise ConfigurationError(
                f"Fault manifest tools must contain non-empty filenames: "
                f"{manifest_file}"
            )
        tool_name = raw_tool.strip()
        if Path(tool_name).name != tool_name or tool_name in {".", ".."}:
            raise ConfigurationError(
                f"Fault tool must be a filename without directories: {tool_name!r}"
            )
        if tool_name in tool_names:
            raise ConfigurationError(
                f"Fault manifest contains duplicate tool {tool_name!r}: "
                f"{manifest_file}"
            )
        tool_file = tools_directory / tool_name
        if not tool_file.is_file():
            raise ConfigurationError(
                f"Fault tool does not exist: {tool_file}"
            )
        tool_names.append(tool_name)
        tool_files.append(tool_file)

    tools_by_name = dict(zip(tool_names, tool_files, strict=True))
    raw_agent_tools = manifest.get("agent_tools", tool_names)
    if not isinstance(raw_agent_tools, list):
        raise ConfigurationError(
            f"Fault manifest agent_tools must be a list: {manifest_file}"
        )
    agent_tool_names: list[str] = []
    agent_tool_files: list[Path] = []
    for raw_agent_tool in raw_agent_tools:
        if (
            not isinstance(raw_agent_tool, str)
            or not raw_agent_tool.strip()
        ):
            raise ConfigurationError(
                "Fault manifest agent_tools must contain non-empty "
                f"filenames: {manifest_file}"
            )
        agent_tool_name = raw_agent_tool.strip()
        if agent_tool_name in agent_tool_names:
            raise ConfigurationError(
                "Fault manifest contains duplicate agent tool "
                f"{agent_tool_name!r}: {manifest_file}"
            )
        try:
            agent_tool_file = tools_by_name[agent_tool_name]
        except KeyError as exc:
            raise ConfigurationError(
                "Fault agent_tools must name declared tools; unknown "
                f"{agent_tool_name!r}: {manifest_file}"
            ) from exc
        agent_tool_names.append(agent_tool_name)
        agent_tool_files.append(agent_tool_file)

    raw_verifier = manifest.get("authoritative_verifier")
    authoritative_verifier_command = None
    authoritative_verifier_timeout_seconds = 30.0
    if raw_verifier is not None:
        if not isinstance(raw_verifier, dict):
            raise ConfigurationError(
                "Fault manifest authoritative_verifier must be an object: "
                f"{manifest_file}"
            )

        raw_command = raw_verifier.get("command")
        if (
            not isinstance(raw_command, list)
            or not raw_command
            or not all(
                isinstance(argument, str) and argument.strip()
                for argument in raw_command
            )
        ):
            raise ConfigurationError(
                "Fault authoritative_verifier command must be a non-empty "
                f"list of arguments: {manifest_file}"
            )

        resolved_command: list[str] = []
        for argument in raw_command:
            match = _TOOL_REFERENCE.fullmatch(argument)
            if match is None:
                resolved_command.append(argument)
                continue
            tool_name = match.group(1)
            try:
                tool_file = tools_by_name[tool_name]
            except KeyError as exc:
                raise ConfigurationError(
                    "Fault authoritative_verifier references undeclared tool "
                    f"{tool_name!r}: {manifest_file}"
                ) from exc
            resolved_command.append(str(tool_file.resolve()))
        authoritative_verifier_command = tuple(resolved_command)

        raw_timeout = raw_verifier.get("timeout_seconds", 30)
        if (
            isinstance(raw_timeout, bool)
            or not isinstance(raw_timeout, (int, float))
            or raw_timeout <= 0
        ):
            raise ConfigurationError(
                "Fault authoritative_verifier timeout_seconds must be "
                f"positive: {manifest_file}"
            )
        authoritative_verifier_timeout_seconds = float(raw_timeout)

    injection_method: str | None = None
    raw_method = manifest.get("injection_method")
    if raw_method is not None:
        if not isinstance(raw_method, str) or not raw_method.strip():
            raise ConfigurationError(
                "Fault manifest injection_method must be a non-empty string: "
                f"{manifest_file}"
            )
        injection_method = raw_method.strip()

    injection_plan = _load_injection_plan(manifest, manifest_file)
    injection_runtime = _load_injection_runtime(manifest, manifest_file)
    if injection_method is None:
        if injection_plan and not injection_runtime:
            injection_method = "file_tamper"
        elif injection_runtime:
            injection_method = (
                _infer_method_from_runtime(injection_runtime)
                or "tool_result_tamper"
            )
        elif injection_plan:
            injection_method = "file_tamper"
        else:
            injection_method = "skill_inject"

    assets_dir = directory / "assets"
    if not assets_dir.is_dir():
        assets_dir = None

    return FaultDefinition(
        name=name,
        skill_name=values["skill_name"],
        skill_file=skill_file,
        description=values["description"],
        tool_files=tuple(tool_files),
        agent_tool_files=tuple(agent_tool_files),
        authoritative_verifier_command=authoritative_verifier_command,
        authoritative_verifier_timeout_seconds=(
            authoritative_verifier_timeout_seconds
        ),
        injection_method=injection_method,
        injection_plan=injection_plan,
        injection_runtime=injection_runtime,
        assets_dir=assets_dir,
    )


def _parse_injection_step(
    raw_step: dict[str, Any],
    *,
    index: int,
    manifest_file: Path | None,
    allow_when: bool,
) -> InjectionStep:
    op = raw_step.get("op")
    if not isinstance(op, str) or not op.strip():
        raise ConfigurationError(
            "Fault injection step requires non-empty op "
            f"(index {index}): {manifest_file}"
        )
    when_submode = raw_step.get("when_submode")
    if when_submode is not None and (
        not isinstance(when_submode, str) or not when_submode.strip()
    ):
        raise ConfigurationError(
            "Fault injection when_submode must be a non-empty string "
            f"(index {index}): {manifest_file}"
        )
    when_items: tuple[tuple[str, Any], ...] = ()
    if allow_when and "when" in raw_step:
        raw_when = raw_step.get("when")
        if raw_when is not None and not isinstance(raw_when, dict):
            raise ConfigurationError(
                "Fault injection when must be an object "
                f"(index {index}): {manifest_file}"
            )
        if isinstance(raw_when, dict):
            when_items = tuple(raw_when.items())

    skip = {"op", "when_submode"}
    if allow_when:
        skip.add("when")
    # Prefer nested args object for runtime steps; fall back to flattened keys.
    raw_args = raw_step.get("args")
    if isinstance(raw_args, dict):
        args = tuple(raw_args.items())
    else:
        args = tuple(
            (key, value) for key, value in raw_step.items() if key not in skip
        )
    return InjectionStep(
        op=op.strip(),
        when_submode=(
            when_submode.strip() if isinstance(when_submode, str) else None
        ),
        args=args,
        when=when_items,
    )


def _load_injection_plan(
    manifest: dict[str, Any],
    manifest_file: Path | None,
) -> tuple[InjectionStep, ...]:
    raw_injection = manifest.get("injection")
    if raw_injection is None:
        return ()
    if not isinstance(raw_injection, dict):
        raise ConfigurationError(
            f"Fault manifest injection must be an object: {manifest_file}"
        )
    raw_steps = raw_injection.get("steps", [])
    if not isinstance(raw_steps, list):
        raise ConfigurationError(
            f"Fault manifest injection.steps must be a list: {manifest_file}"
        )

    steps: list[InjectionStep] = []
    for index, raw_step in enumerate(raw_steps):
        if not isinstance(raw_step, dict):
            raise ConfigurationError(
                "Fault injection step must be an object "
                f"(index {index}): {manifest_file}"
            )
        steps.append(
            _parse_injection_step(
                raw_step,
                index=index,
                manifest_file=manifest_file,
                allow_when=False,
            )
        )
    return tuple(steps)


def _load_injection_runtime(
    manifest: dict[str, Any],
    manifest_file: Path | None,
) -> tuple[InjectionStep, ...]:
    raw_injection = manifest.get("injection")
    if raw_injection is None:
        return ()
    if not isinstance(raw_injection, dict):
        return ()
    raw_steps = raw_injection.get("runtime", [])
    if raw_steps is None:
        return ()
    if not isinstance(raw_steps, list):
        raise ConfigurationError(
            f"Fault manifest injection.runtime must be a list: {manifest_file}"
        )
    steps: list[InjectionStep] = []
    for index, raw_step in enumerate(raw_steps):
        if not isinstance(raw_step, dict):
            raise ConfigurationError(
                "Fault injection.runtime step must be an object "
                f"(index {index}): {manifest_file}"
            )
        steps.append(
            _parse_injection_step(
                raw_step,
                index=index,
                manifest_file=manifest_file,
                allow_when=True,
            )
        )
    return tuple(steps)


def add_fault(
    *,
    name: str,
    skill_file: Path,
    description: str | None = None,
    label_zh: str | None = None,
    label_en: str | None = None,
    order: int | None = None,
    skills_root: Path | None = None,
) -> FaultDefinition:
    """Validate and install one fault without editing Python source."""

    normalized_name = _validate_fault_name(name)
    source = skill_file.expanduser().resolve()
    if not source.is_file():
        raise ConfigurationError(f"Fault skill does not exist: {source}")
    read_frontmatter(source)

    normalized_description = (
        description.strip() if description is not None else None
    )
    if normalized_description is not None and not normalized_description:
        raise ConfigurationError("Fault description must not be empty")

    root = skills_root or default_skills_root()
    destination = root / normalized_name
    if destination.exists():
        raise InstallationConflictError(
            f"Refusing to overwrite existing fault: {destination}"
        )

    created = False
    try:
        destination.mkdir(parents=True)
        created = True
        target = destination / "SKILL.md"
        shutil.copy2(source, target)
        frontmatter = read_frontmatter(target)
        if normalized_description is not None:
            frontmatter["description"] = normalized_description
        metadata = metadata_dict(frontmatter)
        metadata = dict(metadata)
        if label_zh and label_zh.strip():
            metadata["label_zh"] = label_zh.strip()
        elif "label_zh" not in metadata:
            metadata["label_zh"] = normalized_name
        if label_en and label_en.strip():
            metadata["label_en"] = label_en.strip()
        elif "label_en" not in metadata:
            metadata["label_en"] = normalized_name
        if order is not None:
            metadata["order"] = int(order)
        frontmatter["metadata"] = metadata
        write_frontmatter(target, frontmatter)
    except BaseException:
        if created:
            shutil.rmtree(destination)
        raise

    from .presentation import invalidate_fault_ui_catalog

    invalidate_fault_ui_catalog()
    return load_fault_definition(destination)


class FaultRegistry:
    def __init__(self, skills_root: Path | None = None) -> None:
        root = skills_root or default_skills_root()
        self._faults = {
            definition.name: definition
            for directory in sorted(root.iterdir())
            if directory.is_dir() and (directory / "SKILL.md").is_file()
            for definition in (load_fault_definition(directory),)
        }

    def get(self, name: str) -> FaultDefinition:
        normalized = name.strip().lower()
        try:
            fault = self._faults[normalized]
        except KeyError as exc:
            available = ", ".join(sorted(self._faults))
            raise FaultNotFoundError(
                f"Unknown fault {name!r}. Available faults: {available}"
            ) from exc

        if not fault.skill_file.is_file():
            raise FaultNotFoundError(
                f"Fault {name!r} is registered but its SKILL.md is missing"
            )
        return fault

    def names(self) -> tuple[str, ...]:
        return tuple(sorted(self._faults))
