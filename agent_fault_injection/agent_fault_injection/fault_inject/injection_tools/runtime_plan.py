"""Runtime middleware injection plan helpers (tool/model rewrite recipes)."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any

from ..models import InjectionStep


def filter_runtime_steps_for_submode(
    steps: tuple[InjectionStep, ...] | list[InjectionStep],
    submode: str | None,
) -> tuple[InjectionStep, ...]:
    """Drop runtime steps whose when_submode does not match the active submode."""

    active = str(submode).strip() if submode is not None else "1"
    selected: list[InjectionStep] = []
    for step in steps:
        if step.when_submode is None:
            selected.append(step)
            continue
        if str(step.when_submode).strip() == active:
            selected.append(step)
    return tuple(selected)


def runtime_plan_to_json(steps: tuple[InjectionStep, ...] | list[InjectionStep]) -> str:
    payload: list[dict[str, Any]] = []
    for step in steps:
        item: dict[str, Any] = {"op": step.op, "args": step.arg_map()}
        if step.when:
            item["when"] = dict(step.when)
        if step.when_submode is not None:
            item["when_submode"] = step.when_submode
        payload.append(item)
    return json.dumps(payload, ensure_ascii=False)


def parse_runtime_plan_json(raw: str | None) -> list[dict[str, Any]]:
    if not raw or not raw.strip():
        return []
    value = json.loads(raw)
    if not isinstance(value, list):
        raise ValueError("AGENT_RAS_INJECTION_RUNTIME must be a JSON array")
    return [item for item in value if isinstance(item, dict)]


def _tool_matches(pattern: str | None, tool: str) -> bool:
    if pattern is None or pattern == "*" or pattern == "":
        return True
    return re.fullmatch(pattern, tool) is not None


def _when_matches(when: dict[str, Any], *, tool: str, call_index: int) -> bool:
    if not _tool_matches(
        str(when["tool"]) if when.get("tool") is not None else None,
        tool,
    ):
        return False
    if "call_index" in when:
        wanted = when["call_index"]
        if isinstance(wanted, bool) or not isinstance(wanted, int):
            return False
        if call_index != wanted:
            return False
    return True


def apply_tool_result_rewrite(
    plan: list[dict[str, Any]] | tuple[InjectionStep, ...],
    *,
    tool: str,
    call_index: int,
    output: str,
) -> tuple[str, dict[str, Any]]:
    """Apply the first matching tool_result.* step; return (output, meta)."""

    steps: list[dict[str, Any]]
    if plan and isinstance(plan[0], InjectionStep):
        steps = json.loads(runtime_plan_to_json(plan))  # type: ignore[arg-type]
    else:
        steps = list(plan)  # type: ignore[arg-type]

    for step in steps:
        op = str(step.get("op") or "")
        if not op.startswith("tool_result."):
            continue
        when = step.get("when") if isinstance(step.get("when"), dict) else {}
        if not _when_matches(when, tool=tool, call_index=call_index):
            continue
        args = step.get("args") if isinstance(step.get("args"), dict) else {}
        if op in {"tool_result.replace_text", "tool_result.replace_all"}:
            source = args.get("from")
            dest = args.get("to")
            if not isinstance(source, str) or not isinstance(dest, str):
                continue
            if source not in output:
                continue
            rewritten = output.replace(source, dest)
            return rewritten, {
                "applied": True,
                "op": op,
                "tool": tool,
                "call_index": call_index,
                "from": source,
                "to": dest,
            }
    return output, {"applied": False, "op": None}


def next_tool_call_index(counts_file: Path, tool: str) -> int:
    """Atomically-ish bump a durable per-tool call counter (1-based).

    xiaoO invokes the hooker as a fresh process per hook, so counters must
    live on disk under the run's raw/artifacts directory.
    """

    counts_file.parent.mkdir(parents=True, exist_ok=True)
    counts: dict[str, int] = {}
    if counts_file.is_file():
        try:
            loaded = json.loads(counts_file.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                for key, value in loaded.items():
                    if isinstance(value, int) and not isinstance(value, bool):
                        counts[str(key)] = value
        except (OSError, json.JSONDecodeError, TypeError, ValueError):
            counts = {}
    index = int(counts.get(tool, 0)) + 1
    counts[tool] = index
    counts_file.write_text(
        json.dumps(counts, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return index


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def write_runtime_rewrite_artifacts(
    artifacts_dir: Path,
    *,
    kind: str,
    label: str,
    index: int,
    before: str,
    after: str,
    meta: dict[str, Any],
) -> dict[str, str]:
    """Persist before/after snapshots for Judge audit."""

    artifacts_dir.mkdir(parents=True, exist_ok=True)
    safe_kind = re.sub(r"[^A-Za-z0-9._-]+", "_", kind) or "runtime"
    safe_label = re.sub(r"[^A-Za-z0-9._-]+", "_", label) or "item"
    stem = f"runtime-{safe_kind}-{safe_label}-{index}"
    before_path = artifacts_dir / f"{stem}.before.txt"
    after_path = artifacts_dir / f"{stem}.after.txt"
    meta_path = artifacts_dir / f"{stem}.meta.json"
    before_path.write_text(before, encoding="utf-8")
    after_path.write_text(after, encoding="utf-8")
    record = {
        **meta,
        "before_sha256": sha256_text(before),
        "after_sha256": sha256_text(after),
        "before_path": str(before_path),
        "after_path": str(after_path),
    }
    meta_path.write_text(
        json.dumps(record, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return {
        "before_path": str(before_path),
        "after_path": str(after_path),
        "meta_path": str(meta_path),
    }


def _plan_as_dicts(
    plan: list[dict[str, Any]] | tuple[InjectionStep, ...],
) -> list[dict[str, Any]]:
    if plan and isinstance(plan[0], InjectionStep):
        return json.loads(runtime_plan_to_json(plan))  # type: ignore[arg-type]
    return list(plan)  # type: ignore[arg-type]


def apply_system_rewrite(
    plan: list[dict[str, Any]] | tuple[InjectionStep, ...],
    *,
    system_parts: list[str],
) -> tuple[list[str], dict[str, Any]]:
    """Apply first matching system.* step to system prompt parts."""

    parts = list(system_parts)
    for step in _plan_as_dicts(plan):
        op = str(step.get("op") or "")
        args = step.get("args") if isinstance(step.get("args"), dict) else {}
        if op == "system.append":
            text = args.get("text")
            if not isinstance(text, str) or not text.strip():
                continue
            parts.append(text)
            return parts, {"applied": True, "op": op, "kind": "prompt"}
        if op == "system.replace_text":
            source = args.get("from")
            dest = args.get("to")
            if not isinstance(source, str) or not isinstance(dest, str):
                continue
            joined = "\n".join(parts)
            if source not in joined:
                continue
            rewritten = joined.replace(source, dest)
            return rewritten.split("\n"), {
                "applied": True,
                "op": op,
                "kind": "prompt",
                "from": source,
                "to": dest,
            }
    return parts, {"applied": False, "op": None}


def apply_assistant_text_rewrite(
    plan: list[dict[str, Any]] | tuple[InjectionStep, ...],
    *,
    text: str,
    call_index: int = 1,
) -> tuple[str, dict[str, Any]]:
    """Apply first matching assistant.* text rewrite."""

    for step in _plan_as_dicts(plan):
        op = str(step.get("op") or "")
        if not op.startswith("assistant."):
            continue
        when = step.get("when") if isinstance(step.get("when"), dict) else {}
        if "call_index" in when:
            wanted = when["call_index"]
            if not isinstance(wanted, int) or isinstance(wanted, bool):
                continue
            if call_index != wanted:
                continue
        args = step.get("args") if isinstance(step.get("args"), dict) else {}
        if op in {"assistant.replace_text", "assistant.truncate"}:
            if op == "assistant.truncate":
                max_chars = args.get("max_chars")
                if not isinstance(max_chars, int) or isinstance(max_chars, bool):
                    continue
                if len(text) <= max_chars:
                    continue
                return text[:max_chars], {
                    "applied": True,
                    "op": op,
                    "kind": "assistant",
                    "call_index": call_index,
                }
            source = args.get("from")
            dest = args.get("to")
            if not isinstance(source, str) or not isinstance(dest, str):
                continue
            if source not in text:
                continue
            return text.replace(source, dest), {
                "applied": True,
                "op": op,
                "kind": "assistant",
                "call_index": call_index,
                "from": source,
                "to": dest,
            }
    return text, {"applied": False, "op": None}


def apply_messages_rewrite(
    plan: list[dict[str, Any]] | tuple[InjectionStep, ...],
    *,
    messages: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Apply first matching messages.* rewrite (history drop / inject)."""

    current = list(messages)
    for step in _plan_as_dicts(plan):
        op = str(step.get("op") or "")
        args = step.get("args") if isinstance(step.get("args"), dict) else {}
        if op == "messages.history.drop":
            count = args.get("count", 1)
            if not isinstance(count, int) or isinstance(count, bool) or count <= 0:
                continue
            if len(current) <= count:
                continue
            # Prefer dropping trailing non-system messages.
            drop_idx: list[int] = []
            for index in range(len(current) - 1, -1, -1):
                role = str(current[index].get("role") or "").lower()
                if role == "system":
                    continue
                drop_idx.append(index)
                if len(drop_idx) >= count:
                    break
            if not drop_idx:
                continue
            keep = [
                message
                for index, message in enumerate(current)
                if index not in set(drop_idx)
            ]
            return keep, {
                "applied": True,
                "op": op,
                "kind": "messages",
                "dropped": len(drop_idx),
            }
        if op == "messages.inject":
            role = args.get("role", "user")
            text = args.get("text")
            position = str(args.get("position") or "merge_user")
            if not isinstance(text, str) or not text.strip():
                continue
            if not isinstance(role, str) or not role.strip():
                continue

            def _role_of(message: dict[str, Any]) -> str:
                if isinstance(message.get("role"), str):
                    return str(message["role"]).lower()
                info = message.get("info")
                if isinstance(info, dict) and isinstance(info.get("role"), str):
                    return str(info["role"]).lower()
                return ""

            def _merge_text(message: dict[str, Any], prefix: str) -> None:
                if isinstance(message.get("content"), str):
                    message["content"] = f"{prefix}\n{message['content']}"
                parts = message.get("parts")
                if isinstance(parts, list):
                    parts.insert(0, {"type": "text", "text": prefix})
                    return
                blocks = message.get("blocks")
                if isinstance(blocks, list):
                    blocks.insert(0, {"type": "text", "text": prefix})
                    return
                message["content"] = prefix

            # Prefer merging into the first matching user turn so platform-native
            # message envelopes (OpenCode info/parts) keep validating.
            if position in {"merge_user", "prepend", "append"}:
                blob = json.dumps(current, ensure_ascii=False)
                if text.strip() in blob:
                    continue
                target_index = None
                for index, message in enumerate(current):
                    if _role_of(message) == "user":
                        target_index = index
                        if position != "append":
                            break
                if target_index is None:
                    continue
                updated = [dict(item) for item in current]
                target = dict(updated[target_index])
                if isinstance(target.get("parts"), list):
                    target["parts"] = list(target["parts"])
                if isinstance(target.get("blocks"), list):
                    target["blocks"] = list(target["blocks"])
                if isinstance(target.get("info"), dict):
                    target["info"] = dict(target["info"])
                _merge_text(target, text.strip())
                updated[target_index] = target
                return updated, {
                    "applied": True,
                    "op": op,
                    "kind": "messages",
                    "role": role.strip(),
                    "position": "merge_user",
                }
            message = {
                "role": role.strip(),
                "content": text,
                "blocks": [{"type": "text", "text": text}],
                "message_id": None,
                "timestamp_ms": 0,
                "api_usage_tokens": None,
            }
            current = current + [message]
            return current, {
                "applied": True,
                "op": op,
                "kind": "messages",
                "role": role.strip(),
                "position": position,
            }
    return current, {"applied": False, "op": None}
