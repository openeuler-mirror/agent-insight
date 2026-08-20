"""Structural injection Commands: file.* only (no evidence self-logging)."""

from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import Any

from .context import InjectionContext
from . import op_registry


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _read_optional_bytes(path: Path) -> bytes | None:
    if not path.exists() or path.is_dir():
        return None
    return path.read_bytes()


def _snapshot_info(path: Path, data: bytes | None) -> dict[str, Any]:
    return {
        "path": str(path),
        "exists": data is not None,
        "sha256": _sha256_bytes(data) if data is not None else None,
        "size": len(data) if data is not None else 0,
    }


def _require_path(args: dict[str, Any]) -> str:
    path = args.get("path")
    if not isinstance(path, str) or not path.strip():
        raise ValueError("Injection op requires non-empty string path")
    return path.strip()


def file_write(ctx: InjectionContext, args: dict[str, Any]) -> dict[str, Any]:
    relative = _require_path(args)
    target = ctx.resolve_workspace_path(relative)
    from_asset = args.get("from_asset")
    content = args.get("content")
    if from_asset is not None:
        if not isinstance(from_asset, str) or not from_asset.strip():
            raise ValueError("from_asset must be a non-empty string")
        data = ctx.resolve_asset(from_asset.strip()).read_bytes()
    elif content is not None:
        if not isinstance(content, str):
            raise ValueError("content must be a string")
        data = content.encode("utf-8")
    else:
        raise ValueError("file.write requires from_asset or content")

    ctx.installation.write_bytes(target, data, overwrite=True)
    return {
        "op": "file.write",
        "path": relative,
        **_snapshot_info(target, data),
    }


def file_delete(ctx: InjectionContext, args: dict[str, Any]) -> dict[str, Any]:
    relative = _require_path(args)
    target = ctx.resolve_workspace_path(relative)
    before = _read_optional_bytes(target)
    ctx.installation.delete_path(target)
    return {
        "op": "file.delete",
        "path": relative,
        "before": _snapshot_info(target, before),
        "after": _snapshot_info(target, None),
    }


_HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$")


def _delete_markdown_section(text: str, heading: str) -> str:
    """Remove a markdown section starting at heading through next same/higher level."""

    heading = heading.strip()
    lines = text.splitlines(keepends=True)
    start = None
    level = None
    for index, line in enumerate(lines):
        match = _HEADING_RE.match(line.rstrip("\n"))
        if match is None:
            continue
        current = f"{match.group(1)} {match.group(2).strip()}"
        alt = match.group(0).strip()
        if (
            current == heading
            or alt == heading
            or match.group(2).strip() == heading.lstrip("# ").strip()
        ):
            start = index
            level = len(match.group(1))
            break
    if start is None:
        raise ValueError(f"Markdown section heading not found: {heading}")

    end = len(lines)
    for index in range(start + 1, len(lines)):
        match = _HEADING_RE.match(lines[index].rstrip("\n"))
        if match is not None and len(match.group(1)) <= level:  # type: ignore[operator]
            end = index
            break
    return "".join(lines[:start] + lines[end:])


def file_delete_section(
    ctx: InjectionContext,
    args: dict[str, Any],
) -> dict[str, Any]:
    relative = _require_path(args)
    heading = args.get("heading")
    if not isinstance(heading, str) or not heading.strip():
        raise ValueError("file.delete_section requires heading")
    target = ctx.resolve_workspace_path(relative)
    before = _read_optional_bytes(target)
    if before is None:
        raise FileNotFoundError(f"Cannot delete section; file missing: {relative}")
    text = before.decode("utf-8")
    updated = _delete_markdown_section(text, heading.strip())
    data = updated.encode("utf-8")
    ctx.installation.write_bytes(target, data, overwrite=True)
    return {
        "op": "file.delete_section",
        "path": relative,
        "heading": heading.strip(),
        "before": _snapshot_info(target, before),
        "after": _snapshot_info(target, data),
    }


def file_truncate(ctx: InjectionContext, args: dict[str, Any]) -> dict[str, Any]:
    relative = _require_path(args)
    target = ctx.resolve_workspace_path(relative)
    before = _read_optional_bytes(target)
    if before is None:
        raise FileNotFoundError(f"Cannot truncate missing file: {relative}")

    if "bytes" in args:
        length = args["bytes"]
        if not isinstance(length, int) or length < 0:
            raise ValueError("bytes must be a non-negative int")
        data = before[:length]
    elif args.get("half_line"):
        text = before.decode("utf-8", errors="replace")
        lines = text.splitlines(keepends=True)
        if not lines:
            data = b""
        else:
            last = lines[-1]
            cut = max(1, len(last) // 2)
            data = "".join(lines[:-1] + [last[:cut]]).encode("utf-8")
    else:
        raise ValueError("file.truncate requires bytes or half_line=true")

    ctx.installation.write_bytes(target, data, overwrite=True)
    return {
        "op": "file.truncate",
        "path": relative,
        "before": _snapshot_info(target, before),
        "after": _snapshot_info(target, data),
    }


def file_replace_text(
    ctx: InjectionContext,
    args: dict[str, Any],
) -> dict[str, Any]:
    relative = _require_path(args)
    target = ctx.resolve_workspace_path(relative)
    before = _read_optional_bytes(target)
    if before is None:
        raise FileNotFoundError(f"Cannot replace text in missing file: {relative}")
    text = before.decode("utf-8")

    replacements = args.get("replacements")
    if replacements is None and "from" in args and "to" in args:
        replacements = [{"from": args["from"], "to": args["to"]}]
    if not isinstance(replacements, list) or not replacements:
        raise ValueError("file.replace_text requires replacements or from/to")

    updated = text
    applied: list[dict[str, Any]] = []
    for item in replacements:
        if not isinstance(item, dict):
            raise ValueError("replacement items must be objects")
        source = item.get("from")
        dest = item.get("to")
        if not isinstance(source, str) or not isinstance(dest, str):
            raise ValueError("replacement from/to must be strings")
        count = updated.count(source)
        updated = updated.replace(source, dest)
        applied.append({"from": source, "to": dest, "count": count})

    data = updated.encode("utf-8")
    ctx.installation.write_bytes(target, data, overwrite=True)
    return {
        "op": "file.replace_text",
        "path": relative,
        "replacements": applied,
        "before": _snapshot_info(target, before),
        "after": _snapshot_info(target, data),
    }


def _register_builtins() -> None:
    op_registry.register("file.write", file_write)
    op_registry.register("file.delete", file_delete)
    op_registry.register("file.delete_section", file_delete_section)
    op_registry.register("file.truncate", file_truncate)
    op_registry.register("file.replace_text", file_replace_text)


_register_builtins()
