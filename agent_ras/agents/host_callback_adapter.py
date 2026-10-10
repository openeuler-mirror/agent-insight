# coding: utf-8
# Copyright (c) Huawei Technologies Co., Ltd. 2026. All rights reserved.
"""AgentAdapter that parks invoke_skill until the Host fulfills a request."""
from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any

logger = logging.getLogger(__name__)


class HostCallbackAgentAdapter:
    """Platform Host runs the Judge; Python awaits fulfill(request_id, result).

    Used by OpenCode inproc (and future hosts) so LlmThinkingLoopDetector can
    keep calling ``RASAgents.invoke_skill`` without embedding a nested agent.
    """

    def __init__(self) -> None:
        self._pending: dict[str, dict[str, Any]] = {}
        self._futures: dict[str, asyncio.Future[dict[str, Any]]] = {}
        # request_ids already returned from drain_pending_requests (avoid Host storm)
        self._handed_out: set[str] = set()
        self._lock = asyncio.Lock()

    async def invoke_skill(
        self,
        *,
        role: str,
        skill_name: str,
        payload: str,
        timeout: float,
    ) -> dict:
        if timeout <= 0:
            return {}
        request_id = uuid.uuid4().hex
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[dict[str, Any]] = loop.create_future()
        entry = {
            "request_id": request_id,
            "role": str(role or ""),
            "skill_name": str(skill_name or ""),
            "payload": str(payload or ""),
            "timeout": float(timeout),
        }
        async with self._lock:
            self._pending[request_id] = entry
            self._futures[request_id] = fut
        try:
            return await asyncio.wait_for(asyncio.shield(fut), timeout=float(timeout))
        except asyncio.TimeoutError:
            logger.warning(
                "[HostCallbackAgentAdapter] skill timeout role=%s skill=%s",
                role,
                skill_name,
            )
            async with self._lock:
                self._pending.pop(request_id, None)
                self._futures.pop(request_id, None)
                self._handed_out.discard(request_id)
                if not fut.done():
                    fut.set_result({})
            return {}
        except Exception:
            logger.warning(
                "[HostCallbackAgentAdapter] skill failed role=%s skill=%s",
                role,
                skill_name,
                exc_info=True,
            )
            async with self._lock:
                self._pending.pop(request_id, None)
                self._futures.pop(request_id, None)
                self._handed_out.discard(request_id)
            return {}

    async def warmup_members(self, roles: tuple[str, ...]) -> None:
        return None

    def drain_pending_requests(self) -> list[dict[str, Any]]:
        """Return newly parked Host skill requests (each request_id once)."""
        out: list[dict[str, Any]] = []
        for request_id, entry in self._pending.items():
            if request_id in self._handed_out:
                continue
            self._handed_out.add(request_id)
            out.append(dict(entry))
        return out

    def fulfill(
        self,
        request_id: str,
        result: dict[str, Any] | None = None,
        *,
        error: str | None = None,
    ) -> bool:
        """Resolve a parked invoke_skill. Returns False if id unknown/already done."""
        rid = str(request_id or "")
        fut = self._futures.get(rid)
        if fut is None or fut.done():
            return False
        self._pending.pop(rid, None)
        self._futures.pop(rid, None)
        self._handed_out.discard(rid)
        if error:
            fut.set_result({})
        else:
            fut.set_result(result if isinstance(result, dict) else {})
        return True
