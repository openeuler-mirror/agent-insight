"""Closed L2 capability surface: methods + ops fault modes may reference."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterable

import yaml

_CAPABILITY_FILE = Path(__file__).with_name("capability_api.yaml")


def load_capability_api(path: Path | None = None) -> dict[str, Any]:
    target = path or _CAPABILITY_FILE
    data = yaml.safe_load(target.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"Invalid capability API file: {target}")
    return data


def allowed_ops(api: dict[str, Any] | None = None) -> set[str]:
    data = api or load_capability_api()
    structural = data.get("structural_ops") or []
    runtime = data.get("runtime_ops") or []
    return {str(item) for item in [*structural, *runtime]}


def allowed_methods(api: dict[str, Any] | None = None) -> set[str]:
    data = api or load_capability_api()
    methods = data.get("injection_methods") or {}
    if isinstance(methods, dict):
        return {str(key) for key in methods}
    if isinstance(methods, list):
        return {str(item) for item in methods}
    return set()


def method_labels(api: dict[str, Any] | None = None) -> dict[str, str]:
    """Return injection_method id → Chinese label for UI."""

    data = api or load_capability_api()
    methods = data.get("injection_methods") or {}
    labels: dict[str, str] = {}
    if isinstance(methods, dict):
        for key, value in methods.items():
            method_id = str(key)
            if isinstance(value, dict):
                label = value.get("label_zh")
                if isinstance(label, str) and label.strip():
                    labels[method_id] = label.strip()
                    continue
            if isinstance(value, str) and value.strip():
                labels[method_id] = value.strip()
                continue
            labels[method_id] = method_id
    elif isinstance(methods, list):
        for item in methods:
            method_id = str(item)
            labels[method_id] = method_id
    if "skill_inject" not in labels:
        labels["skill_inject"] = "Skill 注入"
    return labels


def _ops_from_steps(steps: Any) -> Iterable[str]:
    if not isinstance(steps, list):
        return
    for step in steps:
        if not isinstance(step, dict):
            continue
        op = step.get("op")
        if isinstance(op, str) and op.strip():
            yield op.strip()


def collect_ops_from_fault_json(manifest: dict[str, Any]) -> set[str]:
    ops: set[str] = set()
    injection = manifest.get("injection")
    if isinstance(injection, dict):
        ops.update(_ops_from_steps(injection.get("steps")))
        ops.update(_ops_from_steps(injection.get("runtime")))
    ops.update(_ops_from_steps(manifest.get("injection_plan")))
    ops.update(_ops_from_steps(manifest.get("injection_runtime")))
    return ops


def validate_fault_json_ops(
    manifest: dict[str, Any],
    *,
    api: dict[str, Any] | None = None,
    source: str = "fault.json",
) -> list[str]:
    """Return human-readable errors for unknown ops/methods (empty = ok)."""

    capability = api or load_capability_api()
    errors: list[str] = []
    method = manifest.get("injection_method")
    if isinstance(method, str) and method.strip():
        methods = allowed_methods(capability)
        if method.strip() not in methods:
            errors.append(
                f"{source}: unknown injection_method {method!r} "
                f"(not in capability_api.yaml)"
            )
    unknown = sorted(collect_ops_from_fault_json(manifest) - allowed_ops(capability))
    errors.extend(
        f"{source}: unknown op {op!r} (not in capability_api.yaml)" for op in unknown
    )
    return errors


def validate_skills_tree(skills_root: Path, *, api: dict[str, Any] | None = None) -> list[str]:
    errors: list[str] = []
    capability = api or load_capability_api()
    if not skills_root.is_dir():
        return [f"skills root missing: {skills_root}"]
    for fault_json in sorted(skills_root.glob("*/fault.json")):
        try:
            manifest = json.loads(fault_json.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            errors.append(f"{fault_json}: invalid JSON ({exc})")
            continue
        if not isinstance(manifest, dict):
            errors.append(f"{fault_json}: root must be object")
            continue
        errors.extend(
            validate_fault_json_ops(
                manifest,
                api=capability,
                source=str(fault_json),
            )
        )
    return errors
