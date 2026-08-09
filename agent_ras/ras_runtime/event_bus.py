# coding: utf-8
# Copyright (c) Huawei Technologies Co., Ltd. 2026. All rights reserved.
"""In-memory ring buffer used for diagnostics inside the embedded runtime."""
from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any


@dataclass
class RasEvent:
    type: str
    session_id: str = ""
    platform: str = ""
    payload: dict[str, Any] = field(default_factory=dict)
    ts: float = field(default_factory=time.time)
    id: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "ts": self.ts,
            "type": self.type,
            "session_id": self.session_id,
            "platform": self.platform,
            "payload": self.payload,
        }


class EventBus:
    """Bounded diagnostics history owned by one embedding host."""

    def __init__(self, maxlen: int = 500) -> None:
        self._events: deque[RasEvent] = deque(maxlen=maxlen)
        self._seq = 0

    @property
    def size(self) -> int:
        return len(self._events)

    def emit(
        self,
        type: str,
        *,
        session_id: str = "",
        platform: str = "",
        payload: dict[str, Any] | None = None,
    ) -> RasEvent:
        self._seq += 1
        event = RasEvent(
            id=self._seq,
            type=type,
            session_id=session_id,
            platform=platform,
            payload=dict(payload or {}),
            ts=time.time(),
        )
        self._events.append(event)
        return event

    def recent(self, limit: int = 200) -> list[dict[str, Any]]:
        items = list(self._events)
        if limit > 0:
            items = items[-limit:]
        return [e.to_dict() for e in items]
