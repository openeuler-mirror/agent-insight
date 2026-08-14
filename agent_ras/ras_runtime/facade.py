# coding: utf-8
# Copyright (c) Huawei Technologies Co., Ltd. 2026. All rights reserved.
"""Synchronous JSON facade for inproc bun:ffi / Python clients."""
from __future__ import annotations

import json
import logging
import os
from typing import Any

from .session_hub import PROTOCOL_VERSION

from .runtime import ensure_runtime, run_coro
from .trail import append_trail

logger = logging.getLogger(__name__)


def call(op: str, session_id: str, payload_json: str = "{}") -> str:
    """
    Synchronous JSON in/out entry for JS FFI.

    op: health | hello | observe | reset | action_result | skill_result | flush | bye

    When a long-lived IPC worker is available (subprocess hook hosts), route
    through it so SessionHub state is shared. Worker sets
    ``RAS_EMBED_IPC_FORCE_LOCAL=1`` to avoid recursion.
    """
    try:
        if _should_use_ipc():
            from platform_adapter.common.transport.subprocess_ipc import call_ipc

            payload = _parse_payload(payload_json)
            result = call_ipc(str(op or ""), str(session_id or ""), payload)
            append_trail(str(op or ""), str(session_id or ""), result)
            return json.dumps(result, ensure_ascii=False)
        result = _dispatch(str(op or ""), str(session_id or ""), payload_json)
        append_trail(str(op or ""), str(session_id or ""), result)
        return json.dumps(result, ensure_ascii=False)
    except Exception as exc:  # noqa: BLE001 — fail-open JSON for embed host
        logger.exception("ras_runtime.call failed op=%s", op)
        err = {"error": str(exc), "op": op, "session_id": session_id}
        append_trail(str(op or ""), str(session_id or ""), err)
        return json.dumps(err)


def _should_use_ipc() -> bool:
    if (os.environ.get("RAS_EMBED_IPC_FORCE_LOCAL") or "").strip() in {
        "1",
        "true",
        "yes",
    }:
        return False
    prefer = (os.environ.get("RAS_EMBED_USE_IPC") or "").strip().lower()
    if prefer in {"0", "false", "no"}:
        return False
    try:
        from platform_adapter.common.transport.subprocess_ipc import ipc_available

        return ipc_available()
    except Exception:
        return False


def _parse_payload(payload_json: str | None) -> dict[str, Any]:
    if not payload_json:
        return {}
    try:
        raw = json.loads(payload_json)
    except json.JSONDecodeError as exc:
        return {"_parse_error": str(exc)}
    return raw if isinstance(raw, dict) else {}


def _require_platform(payload: dict[str, Any]) -> str | None:
    platform = str(payload.get("platform") or "").strip()
    return platform or None


def _dispatch(op: str, session_id: str, payload_json: str | None) -> dict[str, Any]:
    payload = _parse_payload(payload_json)
    if "_parse_error" in payload:
        return {"error": f"invalid json: {payload['_parse_error']}"}

    hub, _ = ensure_runtime()

    if op == "health":
        async def _health() -> dict[str, Any]:
            return {
                "status": "ok",
                "transport": "inproc",
                "protocol_version": PROTOCOL_VERSION,
                "session_count": len(hub.list_sessions()),
            }

        return run_coro(_health())

    if op == "hello":
        platform = _require_platform(payload)
        if not platform:
            return {"error": "missing platform", "op": op, "session_id": session_id}
        async def _hello() -> dict[str, Any]:
            state = hub.hello(session_id, platform, payload.get("config"))
            return {
                "protocol_version": PROTOCOL_VERSION,
                "type": "welcome",
                "session_id": session_id,
                "platform": platform,
                "locale": state.locale,
                "host_messages": hub.host_messages(session_id),
            }

        return run_coro(_hello())

    if op == "observe":
        return run_coro(hub.observe(session_id, payload))

    if op == "reset":
        async def _reset() -> dict[str, Any]:
            hub.reset(session_id)
            return {"session_id": session_id, "ok": True}

        return run_coro(_reset())

    if op == "action_result":
        async def _action_result() -> dict[str, Any]:
            if hub.get(session_id) is None:
                platform = _require_platform(payload)
                if not platform:
                    return {
                        "error": "missing platform",
                        "op": op,
                        "session_id": session_id,
                    }
                hub.ensure(session_id, platform, payload.get("config"))
            return await hub.action_result(session_id, payload)

        return run_coro(_action_result())

    if op == "skill_result":
        async def _skill_result() -> dict[str, Any]:
            if hub.get(session_id) is None:
                return {
                    "session_id": session_id,
                    "ok": False,
                    "error": "unknown_session",
                }
            return await hub.skill_result(session_id, payload)

        return run_coro(_skill_result())

    if op == "flush":
        try:
            timeout_ms = int(payload.get("timeout_ms") or 2500)
        except (TypeError, ValueError):
            timeout_ms = 2500
        return run_coro(
            hub.flush(session_id, timeout_ms),
            timeout=max(1.0, min(timeout_ms / 1000.0 + 1.0, 31.0)),
        )

    if op == "bye":
        async def _bye() -> dict[str, Any]:
            flushed = await hub.flush(session_id, 2500)
            hub.bye(session_id)
            return {"session_id": session_id, "ok": True, "flush": flushed}

        return run_coro(_bye(), timeout=4.0)

    return {"error": f"unknown op: {op}", "op": op}
