"""Strategy-style rewriters for runtime middleware ops (tool/system/messages/assistant)."""

from __future__ import annotations

import json
import re
from typing import Any

from ..catalog.models import InjectionStep
from .runtime_env import plan_as_dicts


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

    for step in plan_as_dicts(plan):
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


def apply_system_rewrite(
    plan: list[dict[str, Any]] | tuple[InjectionStep, ...],
    *,
    system_parts: list[str],
) -> tuple[list[str], dict[str, Any]]:
    """Apply first matching system.* step to system prompt parts."""

    parts = list(system_parts)
    for step in plan_as_dicts(plan):
        op = str(step.get("op") or "")
        args = step.get("args") if isinstance(step.get("args"), dict) else {}
        if op == "system.append":
            text = args.get("text")
            if not isinstance(text, str) or not text.strip():
                continue
            joined = "\n".join(parts)
            if text not in joined:
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

    for step in plan_as_dicts(plan):
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
    for step in plan_as_dicts(plan):
        op = str(step.get("op") or "")
        args = step.get("args") if isinstance(step.get("args"), dict) else {}
        if op == "messages.history.drop":
            count = args.get("count", 1)
            if not isinstance(count, int) or isinstance(count, bool) or count <= 0:
                continue
            if len(current) <= count:
                continue
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
