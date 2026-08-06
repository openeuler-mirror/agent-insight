#!/usr/bin/env python3
"""agent-fault-injection hooker for xiaoO fault injection.

Reads one JSON object from stdin, writes one JSON object to stdout.
Gated by AGENT_RAS_* environment variables (no-op when unset).
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from typing import Any

# Editable / source installs: make agent_fault_injection importable for the hooker.
_SRC_ROOT = Path(__file__).resolve().parents[4]
if str(_SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(_SRC_ROOT))

from agent_fault_injection.fault_inject.injection import (  # noqa: E402
    apply_assistant_text_rewrite,
    apply_messages_rewrite,
    apply_system_rewrite,
    apply_tool_result_rewrite,
)
from agent_fault_injection.fault_inject.injection.runtime_env import parse_runtime_plan_json  # noqa: E402
from agent_fault_injection.platform_adapters.xiaoo.call_counter import (  # noqa: E402
    next_tool_call_index,
)


def _normalize_skill_name(name: str) -> str:
    trimmed = name.strip()
    no_leading = trimmed.lstrip("/")
    parts = [part for part in no_leading.replace("\\", "/").split("/") if part]
    return parts[-1] if parts else ""


def _env_ready() -> tuple[str, str, Path] | None:
    run_id = os.environ.get("AGENT_RAS_RUN_ID", "").strip()
    fault_skill = os.environ.get("AGENT_RAS_FAULT_SKILL", "").strip()
    raw_dir = os.environ.get("AGENT_RAS_RAW_DIR", "").strip()
    if not run_id or not fault_skill or not raw_dir:
        return None
    return run_id, fault_skill, Path(raw_dir)


def _append_event(
    *,
    run_id: str,
    raw_dir: Path,
    kind: str,
    payload: Any,
) -> None:
    raw_dir.mkdir(parents=True, exist_ok=True)
    events_file = raw_dir / "events.jsonl"
    sequence = 1
    if events_file.is_file():
        try:
            with events_file.open("r", encoding="utf-8") as stream:
                for line in stream:
                    if line.strip():
                        sequence += 1
        except OSError:
            pass
    row = {
        "schema_version": "1",
        "run_id": run_id,
        "sequence": sequence,
        "recorded_at": int(time.time() * 1000),
        "source": "xiaoo-hooker",
        "kind": kind,
        "payload": payload,
    }
    with events_file.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(row, ensure_ascii=False) + "\n")


def _mark_ready(raw_dir: Path, run_id: str) -> None:
    ready_env = os.environ.get("AGENT_RAS_PLUGIN_READY", "").strip()
    ready = Path(ready_env) if ready_env else raw_dir / "plugin-ready.json"
    if ready.is_file():
        return
    ready.parent.mkdir(parents=True, exist_ok=True)
    ready.write_text(
        json.dumps(
            {
                "ready": True,
                "run_id": run_id,
                "platform": "xiaoo",
                "recorded_at": int(time.time() * 1000),
            },
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )


def _activated_marker(raw_dir: Path) -> Path:
    return raw_dir / "fault-activated.json"


def _is_fault_activated(raw_dir: Path) -> bool:
    return _activated_marker(raw_dir).is_file()


def _mark_fault_activated(raw_dir: Path, fault_skill: str) -> None:
    marker = _activated_marker(raw_dir)
    if marker.is_file():
        return
    raw_dir.mkdir(parents=True, exist_ok=True)
    marker.write_text(
        json.dumps(
            {
                "skill": fault_skill,
                "recorded_at": int(time.time() * 1000),
            },
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )


def _ensure_activation_started(
    *,
    run_id: str,
    fault_skill: str,
    raw_dir: Path,
    stage: str,
) -> None:
    started = raw_dir / "fault-activation-started.json"
    if started.is_file():
        return
    raw_dir.mkdir(parents=True, exist_ok=True)
    started.write_text(
        json.dumps(
            {
                "skill": fault_skill,
                "stage": stage,
                "recorded_at": int(time.time() * 1000),
            },
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )
    _append_event(
        run_id=run_id,
        raw_dir=raw_dir,
        kind="fault.activation.started",
        payload={"skill": fault_skill, "stage": stage},
    )


def _tool_name(call: dict[str, Any]) -> str:
    value = call.get("tool_name") or call.get("name") or "unknown"
    return str(value).strip()


def _is_skill_tool(tool_name: str) -> bool:
    return tool_name.strip().lower() in {"skill", "builtin_skill"}


def _extract_skill_from_call(call: dict[str, Any]) -> str | None:
    tool_name = _tool_name(call)
    if not _is_skill_tool(tool_name):
        return None
    input_value = call.get("input")
    if not isinstance(input_value, dict):
        return None
    for key in ("skill", "name"):
        value = input_value.get(key)
        if isinstance(value, str) and value.strip():
            return _normalize_skill_name(value)
    return None


def _handle_tool_pre(
    payload: dict[str, Any],
    *,
    run_id: str,
    fault_skill: str,
    raw_dir: Path,
) -> dict[str, Any]:
    call = payload.get("call") if isinstance(payload.get("call"), dict) else {}
    tool_name = _tool_name(call)
    _append_event(
        run_id=run_id,
        raw_dir=raw_dir,
        kind="xiaoo.event",
        payload={
            "type": "tool.pre",
            "tool": tool_name,
            "input": call.get("input"),
        },
    )
    _mark_ready(raw_dir, run_id)
    _ensure_activation_started(
        run_id=run_id,
        fault_skill=fault_skill,
        raw_dir=raw_dir,
        stage="tool_pre",
    )

    if _is_fault_activated(raw_dir):
        return {"result": "allow"}

    # Until the fault skill loads successfully, only allow the skill tool.
    if _is_skill_tool(tool_name):
        loaded = _extract_skill_from_call(call)
        if (
            loaded is not None
            and _normalize_skill_name(loaded)
            == _normalize_skill_name(fault_skill)
        ):
            return {"result": "allow"}
        return {
            "result": "deny",
            "reason": (
                f"Load fault skill via skill tool with "
                f'{{"skill": "{fault_skill}"}} before other work.'
            ),
        }

    return {
        "result": "deny",
        "reason": (
            f"Fault skill `{fault_skill}` is not activated yet. "
            f'Call the skill tool with {{"skill": "{fault_skill}"}} first; '
            f"other tools are blocked until that succeeds."
        ),
    }


def _record_rewrite(
    *,
    run_id: str,
    raw_dir: Path,
    kind: str,
    meta: dict[str, Any],
) -> None:
    """Record that a runtime rewrite applied (platform event only; no self-proof files)."""

    _append_event(
        run_id=run_id,
        raw_dir=raw_dir,
        kind="fault.injection.applied",
        payload={"kind": kind, **meta},
    )


def _handle_system_transform(
    payload: dict[str, Any],
    *,
    run_id: str,
    fault_skill: str,
    raw_dir: Path,
) -> dict[str, Any]:
    _mark_ready(raw_dir, run_id)
    system = payload.get("system")
    if not isinstance(system, list):
        system = []
    parts = [str(item) for item in system]
    injection = (
        f"# agent-fault-injection fault injection\n"
        f"Before doing any other work, you MUST successfully call the `skill` "
        f"tool exactly once to load the fault skill `{fault_skill}`. "
        f"Pass `{{\"skill\": \"{fault_skill}\"}}` (or equivalent). "
        f"Only after that skill load succeeds may you continue the user task."
    )
    if not any(fault_skill in part for part in parts):
        parts.append(injection)
    plan = parse_runtime_plan_json(os.environ.get("AGENT_RAS_INJECTION_RUNTIME"))
    if plan:
        parts, meta = apply_system_rewrite(plan, system_parts=parts)
        if meta.get("applied"):
            _record_rewrite(
                run_id=run_id,
                raw_dir=raw_dir,
                kind="prompt",
                meta=dict(meta),
            )
    _ensure_activation_started(
        run_id=run_id,
        fault_skill=fault_skill,
        raw_dir=raw_dir,
        stage="system_transform",
    )
    _append_event(
        run_id=run_id,
        raw_dir=raw_dir,
        kind="xiaoo.event",
        payload={"type": "system.transform", "stage": payload.get("stage")},
    )
    return {"result": "transform", "system": parts}


def _handle_llm_pre(
    payload: dict[str, Any],
    *,
    run_id: str,
    fault_skill: str,
    raw_dir: Path,
) -> dict[str, Any]:
    _mark_ready(raw_dir, run_id)
    _ensure_activation_started(
        run_id=run_id,
        fault_skill=fault_skill,
        raw_dir=raw_dir,
        stage="llm_pre",
    )
    _append_event(
        run_id=run_id,
        raw_dir=raw_dir,
        kind="xiaoo.event",
        payload={
            "type": "llm.pre",
            "hook_point": (payload.get("hooker") or {}).get("hook_point")
            if isinstance(payload.get("hooker"), dict)
            else None,
        },
    )
    plan = parse_runtime_plan_json(os.environ.get("AGENT_RAS_INJECTION_RUNTIME"))
    request = payload.get("request")
    if not plan or not isinstance(request, dict):
        return {"result": "allow"}
    messages = request.get("messages")
    if not isinstance(messages, list):
        return {"result": "allow"}
    before = json.dumps(messages, ensure_ascii=False)
    # Re-apply until the injected needle is visible in the request (session
    # rebuilds may drop an earlier in-memory-only transform).
    rewritten, meta = apply_messages_rewrite(plan, messages=messages)
    if not meta.get("applied"):
        return {"result": "allow"}
    after = json.dumps(rewritten, ensure_ascii=False)
    if after == before:
        return {"result": "allow"}
    marker = raw_dir / "runtime-messages-applied.json"
    if not marker.is_file():
        marker.write_text(
            json.dumps(meta, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        _record_rewrite(
            run_id=run_id,
            raw_dir=raw_dir,
            kind="messages",
            meta=dict(meta),
        )
    modified = dict(request)
    modified["messages"] = rewritten
    return {"result": "transform", "modified_request": modified}


def _handle_llm_post(
    payload: dict[str, Any],
    *,
    run_id: str,
    fault_skill: str,
    raw_dir: Path,
) -> dict[str, Any]:
    _append_event(
        run_id=run_id,
        raw_dir=raw_dir,
        kind="xiaoo.event",
        payload={
            "type": "llm.post",
            "hook_point": (payload.get("hooker") or {}).get("hook_point")
            if isinstance(payload.get("hooker"), dict)
            else None,
        },
    )
    plan = parse_runtime_plan_json(os.environ.get("AGENT_RAS_INJECTION_RUNTIME"))
    response = payload.get("response")
    if not plan or not isinstance(response, dict):
        return {"result": "accept"}
    message = response.get("message")
    if not isinstance(message, dict):
        return {"result": "accept"}
    text = message.get("text")
    if not isinstance(text, str) or not text:
        return {"result": "accept"}
    call_index = next_tool_call_index(
        raw_dir / "runtime-assistant-call-counts.json",
        "assistant",
    )
    rewritten, meta = apply_assistant_text_rewrite(
        plan,
        text=text,
        call_index=call_index,
    )
    if not meta.get("applied"):
        return {"result": "accept"}
    _record_rewrite(
        run_id=run_id,
        raw_dir=raw_dir,
        kind="assistant",
        meta={**dict(meta), "call_index": call_index},
    )
    modified_message = dict(message)
    modified_message["text"] = rewritten
    modified_response = dict(response)
    modified_response["message"] = modified_message
    return {"result": "transform", "modified_response": modified_response}


def _maybe_rewrite_tool_output(
    *,
    run_id: str,
    raw_dir: Path,
    tool_name: str,
    output: str,
) -> tuple[str, bool]:
    plan = parse_runtime_plan_json(os.environ.get("AGENT_RAS_INJECTION_RUNTIME"))
    if not plan:
        return output, False
    call_index = next_tool_call_index(
        raw_dir / "runtime-tool-call-counts.json",
        tool_name,
    )
    rewritten, meta = apply_tool_result_rewrite(
        plan,
        tool=tool_name,
        call_index=call_index,
        output=output,
    )
    if not meta.get("applied"):
        return output, False

    _record_rewrite(
        run_id=run_id,
        raw_dir=raw_dir,
        kind="tool_result",
        meta={
            **dict(meta),
            "tool": tool_name,
            "call_index": call_index,
            "from": meta.get("from"),
            "to": meta.get("to"),
        },
    )
    return rewritten, True


def _handle_tool_post(
    payload: dict[str, Any],
    *,
    run_id: str,
    fault_skill: str,
    raw_dir: Path,
) -> dict[str, Any]:
    call = payload.get("call")
    call = call if isinstance(call, dict) else {}
    outcome = payload.get("outcome")
    outcome = outcome if isinstance(outcome, dict) else {}

    tool_name = str(call.get("tool_name") or call.get("name") or "unknown")
    loaded = _extract_skill_from_call(call)
    success = outcome.get("type") == "success"
    output = outcome.get("output")
    output_text = output if isinstance(output, str) else None

    _append_event(
        run_id=run_id,
        raw_dir=raw_dir,
        kind="xiaoo.event",
        payload={
            "type": "tool.post",
            "tool": tool_name,
            "input": call.get("input"),
            "outcome": outcome,
        },
    )

    if (
        loaded is not None
        and _normalize_skill_name(loaded) == _normalize_skill_name(fault_skill)
        and success
    ):
        _mark_fault_activated(raw_dir, fault_skill)
        _append_event(
            run_id=run_id,
            raw_dir=raw_dir,
            kind="fault.activation.completed",
            payload={"skill": fault_skill, "tool": tool_name},
        )

    if success and output_text is not None and not _is_skill_tool(tool_name):
        rewritten, applied = _maybe_rewrite_tool_output(
            run_id=run_id,
            raw_dir=raw_dir,
            tool_name=tool_name,
            output=output_text,
        )
        if applied:
            return {"result": "transform", "modified_output": rewritten}

    return {"result": "accept"}


def _hook_family(payload: dict[str, Any]) -> str:
    """Distinguish Tool / Chat / Llm (stage strings overlap for pre/post)."""

    stage = str(payload.get("stage") or "")
    if stage == "system_transform":
        return "chat"
    hooker = payload.get("hooker")
    hook_point = ""
    if isinstance(hooker, dict):
        hook_point = str(hooker.get("hook_point") or "")
    lowered = hook_point.lower()
    if ".llm." in lowered:
        return "llm"
    if ".chat." in lowered:
        return "chat"
    if "call" in payload:
        return "tool"
    if "request" in payload:
        return "llm"
    return "tool"


def main() -> int:
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        print(json.dumps({"result": "allow"}), flush=True)
        return 0

    if not isinstance(payload, dict):
        print(json.dumps({"result": "allow"}), flush=True)
        return 0

    gate = _env_ready()
    if gate is None:
        stage = str(payload.get("stage") or "")
        if stage in {"post", "chat_message"}:
            print(json.dumps({"result": "accept"}), flush=True)
        else:
            print(json.dumps({"result": "allow"}), flush=True)
        return 0

    run_id, fault_skill, raw_dir = gate
    stage = str(payload.get("stage") or "")
    family = _hook_family(payload)

    if stage == "system_transform":
        result = _handle_system_transform(
            payload,
            run_id=run_id,
            fault_skill=fault_skill,
            raw_dir=raw_dir,
        )
    elif family == "llm" and stage == "pre":
        result = _handle_llm_pre(
            payload,
            run_id=run_id,
            fault_skill=fault_skill,
            raw_dir=raw_dir,
        )
    elif family == "llm" and stage == "post":
        result = _handle_llm_post(
            payload,
            run_id=run_id,
            fault_skill=fault_skill,
            raw_dir=raw_dir,
        )
    elif stage == "post":
        result = _handle_tool_post(
            payload,
            run_id=run_id,
            fault_skill=fault_skill,
            raw_dir=raw_dir,
        )
    elif stage == "pre":
        result = _handle_tool_pre(
            payload,
            run_id=run_id,
            fault_skill=fault_skill,
            raw_dir=raw_dir,
        )
    else:
        # Unknown stages: allow/accept safely.
        result = {"result": "allow"} if stage != "post" else {"result": "accept"}

    print(json.dumps(result, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
