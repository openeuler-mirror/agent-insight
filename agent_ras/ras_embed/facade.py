# coding: utf-8
# Copyright (c) Huawei Technologies Co., Ltd. 2026. All rights reserved.
"""Synchronous JSON facade for inproc bun:ffi / Python clients."""
from __future__ import annotations

import json
import logging
from typing import Any

from .session_hub import PROTOCOL_VERSION

from .runtime import ensure_runtime, run_coro
from .trail import append_trail

logger = logging.getLogger(__name__)


def call(op: str, session_id: str, payload_json: str = "{}") -> str:
    """
    Synchronous JSON in/out entry for JS FFI.

    op: health | hello | observe | reset | action_result | skill_result | bye
    """
    try:
        result = _dispatch(str(op or ""), str(session_id or ""), payload_json)
        append_trail(str(op or ""), str(session_id or ""), result)
        return json.dumps(result, ensure_ascii=False)
    except Exception as exc:  # noqa: BLE001 — fail-open JSON for embed host
        logger.exception("ras_embed.call failed op=%s", op)
        err = {"error": str(exc), "op": op, "session_id": session_id}
        append_trail(str(op or ""), str(session_id or ""), err)
        return json.dumps(err)


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
        return {
            "status": "ok",
            "transport": "inproc",
            "protocol_version": PROTOCOL_VERSION,
            "session_count": len(hub.list_sessions()),
        }

    if op == "hello":
        platform = _require_platform(payload)
        if not platform:
            return {"error": "missing platform", "op": op, "session_id": session_id}
        state = hub.hello(session_id, platform, payload.get("config"))
        return {
            "protocol_version": PROTOCOL_VERSION,
            "type": "welcome",
            "session_id": session_id,
            "platform": platform,
            "locale": state.locale,
            "host_messages": hub.host_messages(session_id),
        }

    if op == "observe":
        if hub.get(session_id) is None:
            platform = _require_platform(payload)
            if not platform:
                return {"error": "missing platform", "op": op, "session_id": session_id}
            hub.ensure(session_id, platform, payload.get("config"))
        return run_coro(hub.observe(session_id, payload))

    if op == "reset":
        hub.reset(session_id)
        return {"session_id": session_id, "ok": True}

    if op == "action_result":
        if hub.get(session_id) is None:
            platform = _require_platform(payload)
            if not platform:
                return {"error": "missing platform", "op": op, "session_id": session_id}
            hub.ensure(session_id, platform, payload.get("config"))
        return run_coro(hub.action_result(session_id, payload))

    if op == "skill_result":
        if hub.get(session_id) is None:
            return {"session_id": session_id, "ok": False, "error": "unknown_session"}
        return run_coro(hub.skill_result(session_id, payload))

    if op == "bye":
        hub.bye(session_id)
        return {"session_id": session_id, "ok": True}

    return {"error": f"unknown op: {op}", "op": op}
