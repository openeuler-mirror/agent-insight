"""File-structure injection primitives (fault-agnostic)."""

from __future__ import annotations

import re
from typing import Any

from . import artifacts, events, registry
from .context import InjectionContext


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
        **artifacts.snapshot_info(target, data),
    }


def file_delete(ctx: InjectionContext, args: dict[str, Any]) -> dict[str, Any]:
    relative = _require_path(args)
    target = ctx.resolve_workspace_path(relative)
    before = artifacts.read_optional_bytes(target)
    ctx.installation.delete_path(target)
    return {
        "op": "file.delete",
        "path": relative,
        "before": artifacts.snapshot_info(target, before),
        "after": artifacts.snapshot_info(target, None),
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
        if current == heading or alt == heading or match.group(2).strip() == heading.lstrip("# ").strip():
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
    before = artifacts.read_optional_bytes(target)
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
        "before": artifacts.snapshot_info(target, before),
        "after": artifacts.snapshot_info(target, data),
    }


def file_truncate(ctx: InjectionContext, args: dict[str, Any]) -> dict[str, Any]:
    relative = _require_path(args)
    target = ctx.resolve_workspace_path(relative)
    before = artifacts.read_optional_bytes(target)
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
        "before": artifacts.snapshot_info(target, before),
        "after": artifacts.snapshot_info(target, data),
    }


def file_replace_text(
    ctx: InjectionContext,
    args: dict[str, Any],
) -> dict[str, Any]:
    relative = _require_path(args)
    target = ctx.resolve_workspace_path(relative)
    before = artifacts.read_optional_bytes(target)
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
        "before": artifacts.snapshot_info(target, before),
        "after": artifacts.snapshot_info(target, data),
    }


def artifacts_record(
    ctx: InjectionContext,
    args: dict[str, Any],
) -> dict[str, Any]:
    relative = _require_path(args)
    label = args.get("label")
    if not isinstance(label, str) or not label.strip():
        raise ValueError("artifacts.record requires label")
    target = ctx.resolve_workspace_path(relative)
    data = artifacts.read_optional_bytes(target)
    text = None if data is None else data.decode("utf-8", errors="replace")
    artifacts.write_text_snapshot(
        ctx.artifacts_dir,
        label=label.strip(),
        relative_path=relative,
        text=text,
    )
    info = artifacts.snapshot_info(target, data)
    ctx.snapshots[label.strip()] = {
        "relative_path": relative,
        "text": text,
        **info,
    }
    before = ctx.snapshots.get("before_mut")
    after = ctx.snapshots.get("after_mut")
    if before is not None and after is not None and label.strip() == "after_mut":
        artifacts.write_diff(
            ctx.artifacts_dir,
            before=before.get("text"),
            after=after.get("text"),
        )
    return {"op": "artifacts.record", "label": label.strip(), **info}


def events_emit(ctx: InjectionContext, args: dict[str, Any]) -> dict[str, Any]:
    kind = args.get("kind", "structural")
    if not isinstance(kind, str) or not kind.strip():
        raise ValueError("events.emit kind must be a non-empty string")
    payload = {
        "kind": kind.strip(),
        "submode": ctx.submode,
        "ops": list(ctx.last_ops),
        "snapshots": {
            key: {
                "path": value.get("relative_path"),
                "exists": value.get("exists"),
                "sha256": value.get("sha256"),
                "size": value.get("size"),
            }
            for key, value in ctx.snapshots.items()
        },
    }
    events.append_event(ctx.events_file, "fault.injection.applied", payload)
    # Also emit memory-oriented alias used by memory fault docs.
    events.append_event(ctx.events_file, "memory.fault.injected", payload)
    return {"op": "events.emit", "kind": kind.strip()}


def _register_builtins() -> None:
    registry.register("file.write", file_write)
    registry.register("file.delete", file_delete)
    registry.register("file.delete_section", file_delete_section)
    registry.register("file.truncate", file_truncate)
    registry.register("file.replace_text", file_replace_text)
    registry.register("artifacts.record", artifacts_record)
    registry.register("events.emit", events_emit)


_register_builtins()
